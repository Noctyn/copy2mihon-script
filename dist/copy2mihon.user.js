// ==UserScript==
// @name         copy2mihon - 拷贝漫画转 Mihon 备份工具
// @namespace    https://github.com/taffy/copy2mihon
// @version      0.3.5
// @description  在浏览器中一键导出拷贝漫画书架订阅与阅读历史至 Mihon / Tachiyomi / Komikku 备份 (.tachibk)，支持双向增量合并
// @author       Taffy
// @match        *://*.mangacopy.com/*
// @match        *://*.copy4000.com/*
// @match        *://*.2026copy.com/*
// @match        *://*.copymanga.tv/*
// @match        *://*.copymanga.site/*
// @match        *://*.copymanga.org/*
// @match        *://*.copymanga.com/*
// @require      https://cdn.jsdelivr.net/npm/long@5.2.3/dist/long.js
// @require      https://cdn.jsdelivr.net/npm/protobufjs@7.2.6/dist/protobuf.min.js
// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_cookie
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/*
 * v0.2.0 优化说明:
 * 1. 分页拉取改为有限并发 (默认 3 路)，大幅缩短大书架/长历史的导出时间。
 * 2. 抽取 makeMangaRecord / makeChapterRecord 公共构造函数，消除 convert/merge 中的重复对象字面量。
 * 3. memo 空对象字节仅编码一次并复用引用，减少大量 TextEncoder 调用与内存分配。
 * 4. 合并阶段为每本漫画的章节建立 Map 索引 (按 URL 精确匹配 + 按章节号回退)，
 *    避免历史记录条目对章节列表做重复线性扫描，同时修复了原 `.includes()` 子串匹配可能误配的问题。
 * 5. fallback 章节号解析优先匹配"第X话/回/集"模式，避免把卷号误认成话数。
 * 6. 无 path_word 时的兜底哈希键先做乱码修复 + 归一化，提升书架条目与历史条目匹配到同一部漫画的概率。
 * 7. fetchWithRetry 增加请求超时 (AbortController) 与带抖动的指数退避，429 重试更平滑。
 * 8. 下载优先使用 GM_download（绕过部分站点的 CSP 限制），失败时自动回退到原有的 blob+a 标签方式。
 * 9. 面板 DOM 引用集中缓存，避免高频进度更新时反复 querySelector；并防止脚本在 SPA 场景下重复注入面板。
 * 10. 关键参数集中到 CONFIG，方便按需调整并发数、超时时间、分页大小等。
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const DEFAULT_COPYMANGA_SOURCE_ID = "6696312508930833206";
  const DEFAULT_COPYMANGA_SOURCE_NAME = "拷贝漫画";
  const STORAGE_KEY_TOKEN = "copy2mihon_custom_token";
  const STORAGE_KEY_CATEGORY = "copy2mihon_category_name";
  const STORAGE_KEY_EXPORT_JSON = "copy2mihon_export_json";

  const CONFIG = {
    PAGE_LIMIT: 30,
    MAX_RETRIES: 3,
    MAX_CONCURRENCY: 3,
    REQUEST_TIMEOUT_MS: 15000,
    INTER_REQUEST_DELAY_MS: 150,
  };

  // --- Protobuf Schema Definition (Mihon Backup) ---
  const PROTO_DEFINITION = `
    syntax = "proto2";

    message Backup {
      repeated BackupManga backupManga = 1;
      repeated BackupCategory backupCategories = 2;
      repeated BackupSource backupSources = 102;
    }

    message BackupManga {
      required int64 source = 1;
      required string url = 2;
      optional string title = 3;
      optional string artist = 4;
      optional string author = 5;
      optional string description = 6;
      repeated string genre = 7;
      optional int32 status = 8;
      optional string thumbnailUrl = 9;
      optional int64 dateAdded = 13;
      optional int32 viewer = 14;
      repeated BackupChapter chapters = 16;
      repeated int32 categories = 17;
      optional bool favorite = 100 [default = true];
      optional int32 chapterFlags = 101 [default = 513];
      optional int32 viewer_flags = 103 [default = 0];
      repeated BackupHistory history = 104;
      optional int32 updateStrategy = 105 [default = 0];
      optional int64 lastModifiedAt = 106;
      optional bool initialized = 107 [default = true];
      optional int64 version = 109 [default = 0];
      repeated bytes memo = 110;
    }

    message BackupChapter {
      required string url = 1;
      required string name = 2;
      optional string scanlator = 3;
      optional bool read = 4 [default = false];
      optional bool bookmark = 5 [default = false];
      optional int64 lastPageRead = 6 [default = 0];
      optional int64 dateFetch = 7 [default = 0];
      optional int64 dateUpload = 8 [default = 0];
      optional float chapterNumber = 9 [default = 0];
      optional int64 sourceOrder = 10 [default = 0];
      optional int64 lastModifiedAt = 11;
      optional int64 version = 12 [default = 0];
      repeated bytes memo = 13;
    }

    message BackupCategory {
      required string name = 1;
      optional int32 order = 2 [default = 0];
      optional int32 flags = 100 [default = 0];
      optional int64 id = 101;
    }

    message BackupHistory {
      required string url = 1;
      required int64 lastRead = 2;
      optional int64 readDuration = 3 [default = 0];
    }

    message BackupSource {
      optional string name = 1;
      required int64 sourceId = 2;
    }
  `;

  let protobufRoot = null;
  let BackupType = null;

  function initProtobuf() {
    if (!protobufRoot && window.protobuf) {
      if (window.Long && window.protobuf.util) {
        window.protobuf.util.Long = window.Long;
        window.protobuf.configure();
      }
      protobufRoot = window.protobuf.parse(PROTO_DEFINITION).root;
      BackupType = protobufRoot.lookupType("Backup");
    }
    return BackupType;
  }

  function getSourceIdLong(idStr = DEFAULT_COPYMANGA_SOURCE_ID) {
    if (window.protobuf && window.protobuf.util && window.protobuf.util.Long) {
      return window.protobuf.util.Long.fromString(String(idStr));
    }
    if (window.Long && typeof window.Long.fromString === 'function') {
      return window.Long.fromString(String(idStr));
    }
    try {
      const bi = BigInt(idStr);
      const low = Number(BigInt.asIntN(32, bi));
      const high = Number(BigInt.asIntN(32, bi >> 32n));
      return { low, high, unsigned: false };
    } catch (_) {
      return idStr;
    }
  }

  // --- Small utilities ---
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Encode "{}" once and reuse the same Uint8Array reference everywhere a
  // placeholder memo is needed instead of re-running TextEncoder per record.
  const EMPTY_MEMO_BYTES = new TextEncoder().encode("{}");
  function memoArray() {
    return [EMPTY_MEMO_BYTES];
  }

  // --- Token Sniffer / Storage ---
  let detectedToken = localStorage.getItem(STORAGE_KEY_TOKEN) || "";

  function cleanToken(raw) {
    if (!raw) return "";
    let t = String(raw).trim().replace(/^['"]+|['"]+$/g, '');
    if (t.toLowerCase().startsWith('token ')) t = t.slice(6).trim();
    if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
    return t;
  }

  function detectTokenFromCookie() {
    try {
      const docCookie = (typeof document !== 'undefined' ? document.cookie : '') ||
                        (typeof unsafeWindow !== 'undefined' && unsafeWindow.document ? unsafeWindow.document.cookie : '');
      if (docCookie) {
        // Matches token=xxx, authorization=xxx, auth=xxx, etc.
        const match = docCookie.match(/(?:^|;\s*)(?:token|authorization|auth|copy_token|member_token)=([^;]+)/i);
        if (match && match[1]) {
          const cleaned = cleanToken(decodeURIComponent(match[1]));
          if (cleaned.length >= 20) return cleaned;
        }
      }
    } catch (_) {}
    return '';
  }

  function detectTokenFromStorage() {
    if (detectedToken && detectedToken.length >= 20) return detectedToken;

    // 1. Check custom saved token
    const custom = localStorage.getItem(STORAGE_KEY_TOKEN);
    if (custom && cleanToken(custom).length >= 20) {
      detectedToken = cleanToken(custom);
      return detectedToken;
    }

    // 2. Check document.cookie & unsafeWindow.document.cookie
    const cookieTok = detectTokenFromCookie();
    if (cookieTok) {
      detectedToken = cookieTok;
      return detectedToken;
    }

    // 3. Check localStorage & sessionStorage across window & unsafeWindow
    const winList = [];
    if (typeof window !== 'undefined') winList.push(window);
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) winList.push(unsafeWindow);

    const candidates = ['token', 'authorization', 'auth', 'user_token', 'member_token', 'copy_token'];
    for (const win of winList) {
      for (const k of candidates) {
        try {
          const val = win.localStorage?.getItem(k) || win.sessionStorage?.getItem(k);
          if (val) {
            const cleaned = cleanToken(val);
            if (cleaned.length >= 20) {
              detectedToken = cleaned;
              return detectedToken;
            }
          }
        } catch (_) {}
      }

      // Check vuex / pinia in localStorage
      try {
        const vuexStr = win.localStorage?.getItem('vuex') || win.sessionStorage?.getItem('vuex');
        if (vuexStr) {
          const vObj = JSON.parse(vuexStr);
          const t = vObj?.user?.token || vObj?.auth?.token || vObj?.token || vObj?.userInfo?.token;
          if (t && cleanToken(t).length >= 20) {
            detectedToken = cleanToken(t);
            return detectedToken;
          }
        }
      } catch (_) {}
    }

    // 4. Try GM_cookie if available in extension
    if (typeof GM_cookie !== 'undefined' && typeof GM_cookie.list === 'function') {
      try {
        GM_cookie.list({ name: 'token' }, function (cookies, error) {
          if (!error && cookies && cookies.length > 0) {
            const tok = cleanToken(cookies[0].value);
            if (tok.length >= 20 && tok !== detectedToken) {
              detectedToken = tok;
              updateTokenDisplay();
            }
          }
        });
      } catch (_) {}
    }

    return "";
  }

  // Hook XHR & Fetch in BOTH window and unsafeWindow to catch Token live
  function installNetworkHooks() {
    const winList = [];
    if (typeof window !== 'undefined') winList.push(window);
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) winList.push(unsafeWindow);

    for (const win of winList) {
      try {
        if (win.XMLHttpRequest && win.XMLHttpRequest.prototype) {
          const proto = win.XMLHttpRequest.prototype;
          const origSetHeader = proto.setRequestHeader;
          if (origSetHeader && !proto._c2m_hooked) {
            proto._c2m_hooked = true;
            proto.setRequestHeader = function (header, value) {
              if (header && header.toLowerCase() === 'authorization') {
                const tok = cleanToken(value);
                if (tok && tok.length >= 20 && tok !== detectedToken) {
                  detectedToken = tok;
                  updateTokenDisplay();
                }
              }
              return origSetHeader.apply(this, arguments);
            };
          }
        }

        if (win.fetch && !win.fetch._c2m_hooked) {
          const origFetch = win.fetch;
          const hookedFetch = function (resource, init) {
            if (init && init.headers) {
              let authHeader = null;
              if (init.headers instanceof Headers) {
                authHeader = init.headers.get('authorization');
              } else if (typeof init.headers === 'object') {
                authHeader = init.headers['authorization'] || init.headers['Authorization'];
              }
              if (authHeader) {
                const tok = cleanToken(authHeader);
                if (tok && tok.length >= 20 && tok !== detectedToken) {
                  detectedToken = tok;
                  updateTokenDisplay();
                }
              }
            }
            return origFetch.apply(this, arguments);
          };
          hookedFetch._c2m_hooked = true;
          win.fetch = hookedFetch;
        }
      } catch (_) {}
    }
  }

  // --- Cleaners and Helpers ---
  async function sha1Hex(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function repairMojibake(text) {
    if (!text) return "";
    const replacements = {
      "ç¬¬": "第",
      "è©±": "話",
      "è¯": "话",
      "å ·": "卷",
      "å·»": "卷",
      "å®Œ": "完",
      "ä¸Š": "上",
      "ä¸‹": "下",
      "ä¸": "中",
      "è¯•çœ‹": "试看"
    };
    let res = text;
    for (const [k, v] of Object.entries(replacements)) {
      res = res.replaceAll(k, v);
    }
    return res;
  }

  // Normalize before hashing so a subscription payload and a history payload
  // referring to the same manga (but with slightly different raw title
  // encoding) still fall back to the same synthetic key.
  async function stableFallbackKey(comicItem) {
    const rawTitle = comicItem?.name || comicItem?.title || JSON.stringify(comicItem);
    const normalized = repairMojibake(rawTitle).trim().toLowerCase();
    const hex = await sha1Hex(normalized);
    return `nopathword_${hex.slice(0, 12)}`;
  }

  async function extractPathWord(item, comicData, fallback = true) {
    let pw = (comicData?.path_word || item?.comic_path_word || item?.path_word || "").trim();
    if (!pw) {
      const url = comicData?.url || item?.url || "";
      if (url) {
        const match = url.match(/\/comic\/([^/?#]+)/);
        if (match) pw = match[1].trim();
      }
    }
    if (!pw && fallback) {
      pw = await stableFallbackKey(comicData || item);
    }
    return pw;
  }

  function parseDateTimeToMs(dateVal) {
    if (!dateVal) return Date.now();
    if (typeof dateVal === 'number') {
      return dateVal < 100000000000 ? dateVal * 1000 : dateVal;
    }
    if (typeof dateVal === 'string') {
      const num = Number(dateVal);
      if (!isNaN(num)) {
        return num < 100000000000 ? num * 1000 : num;
      }
      const parsed = Date.parse(dateVal);
      if (!isNaN(parsed)) return parsed;
    }
    return Date.now();
  }

  // Prefer an explicit "第X话/回/集" pattern over a bare first-number match,
  // since volume markers ("第2卷") that precede the real chapter number were
  // previously picked up by mistake.
  function parseChapterNumber(chapterName) {
    if (!chapterName) return 0;
    const preferred = chapterName.match(/第\s*(\d+(?:\.\d+)?)\s*(?:话|話|回|集)/);
    if (preferred) return parseFloat(preferred[1]);
    const allNumbers = chapterName.match(/\d+(?:\.\d+)?/g);
    if (allNumbers && allNumbers.length > 0) {
      return parseFloat(allNumbers[allNumbers.length - 1]);
    }
    return 0;
  }

  function extractChapterUuidFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/chapter\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  // --- Shared record builders (used by both convert & merge paths) ---
  function makeMangaRecord({ pw, title, author, cover, status, dateAdded, favorite, categories }) {
    return {
      source: getSourceIdLong(DEFAULT_COPYMANGA_SOURCE_ID),
      url: `/comic/${pw}`,
      title,
      author,
      artist: author,
      status,
      thumbnailUrl: cover,
      dateAdded,
      favorite,
      initialized: true,
      chapterFlags: 513,
      viewer_flags: 0,
      categories,
      chapters: [],
      history: [],
      memo: memoArray()
    };
  }

  function makeChapterRecord({ url, name, dateFetch, dateUpload, chapterNumber }) {
    return {
      url,
      name,
      read: true,
      lastPageRead: 1,
      dateFetch,
      dateUpload,
      chapterNumber,
      sourceOrder: 0,
      memo: memoArray()
    };
  }

  function deriveComicFields(comic) {
    const title = repairMojibake(comic.name || comic.title || "Unknown");
    const author = (comic.author || []).map(a => repairMojibake(a.name || a)).join(", ");
    const cover = comic.cover || "";
    const status = (comic.status === 2 || comic.status === "2" || (comic.status_str || "").includes("完结")) ? 2 : 1;
    return { title, author, cover, status };
  }

  // --- API Client ---
  async function fetchWithRetry(url, token, maxRetries = CONFIG.MAX_RETRIES) {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Authorization': `Token ${token}`,
      'Platform': '2',
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, { headers, method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.status === 401 || res.status === 403) {
          throw new Error(`Token 无效或无权限 (${res.status})，请检查 Token。`);
        }
        if (res.status === 429) {
          const wait = Math.min(8000, attempt * 1500) + Math.random() * 500;
          await sleep(wait);
          continue;
        }
        if (!res.ok) {
          throw new Error(`HTTP 错误: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        if (data.code && data.code !== 200) {
          throw new Error(`API 业务错误 (${data.code}): ${data.message || '未知'}`);
        }
        return data;
      } catch (err) {
        clearTimeout(timeoutId);
        const isAuthError = err.message && err.message.includes('Token 无效');
        const isTimeout = err.name === 'AbortError';
        if (attempt === maxRetries || isAuthError) {
          throw isTimeout ? new Error('请求超时，请检查网络后重试。') : err;
        }
        const backoff = Math.min(6000, attempt * 800) + Math.random() * 300;
        await sleep(backoff);
      }
    }
  }

  // Generic paginated fetcher with a small worker pool: the first page tells
  // us the total, then the remaining pages are fetched with limited
  // concurrency instead of one-at-a-time, which materially speeds up export
  // for large libraries while still being gentle on the API.
  async function fetchAllPaginated(buildUrl, token, onProgress) {
    const { PAGE_LIMIT, MAX_CONCURRENCY, INTER_REQUEST_DELAY_MS } = CONFIG;
    const results = [];

    const firstResp = await fetchWithRetry(buildUrl(0, PAGE_LIMIT), token);
    const firstList = firstResp?.results?.list || [];
    const total = firstResp?.results?.total ?? firstList.length;
    results.push(...firstList);
    if (onProgress) onProgress(results.length, total);

    if (firstList.length === 0 || results.length >= total || firstList.length < PAGE_LIMIT) {
      return results;
    }

    const offsets = [];
    for (let offset = PAGE_LIMIT; offset < total; offset += PAGE_LIMIT) offsets.push(offset);

    let cursor = 0;
    let fetchedCount = results.length;
    const workerCount = Math.max(1, Math.min(MAX_CONCURRENCY, offsets.length));

    async function worker() {
      while (cursor < offsets.length) {
        const myIndex = cursor++;
        const offset = offsets[myIndex];
        const resp = await fetchWithRetry(buildUrl(offset, PAGE_LIMIT), token);
        const list = resp?.results?.list || [];
        results.push(...list);
        fetchedCount += list.length;
        if (onProgress) onProgress(fetchedCount, total);
        if (INTER_REQUEST_DELAY_MS > 0) await sleep(INTER_REQUEST_DELAY_MS);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  function fetchAllSubscriptions(token, onProgress) {
    const baseUrl = window.location.origin;
    return fetchAllPaginated(
      (offset, limit) => `${baseUrl}/api/v3/member/collect/comics?limit=${limit}&offset=${offset}&free_type=1&ordering=-datetime_modifier`,
      token,
      onProgress
    );
  }

  function fetchAllReadingHistory(token, onProgress) {
    const baseUrl = window.location.origin;
    return fetchAllPaginated(
      (offset, limit) => `${baseUrl}/api/kb/web/browses?limit=${limit}&offset=${offset}`,
      token,
      onProgress
    );
  }

  // --- Data Converter ---
  async function convertToMihonBackup(subscriptions, historyList, categoryName = "拷贝漫画") {
    const catOrders = categoryName && categoryName.toLowerCase() !== 'none' ? [0] : [];
    const mangaByUrl = new Map();

    // 1. Process Subscriptions
    for (const item of subscriptions) {
      const comic = item.comic || item;
      const pw = await extractPathWord(item, comic, true);
      if (!pw) continue;
      const url = `/comic/${pw}`;

      const { title, author, cover, status } = deriveComicFields(comic);
      const dateAdded = parseDateTimeToMs(item.datetime_created || item.last_updatetime);

      mangaByUrl.set(url, makeMangaRecord({
        pw, title, author, cover, status, dateAdded,
        favorite: true,
        categories: [...catOrders]
      }));
    }

    // 2. Process History
    for (const bItem of historyList) {
      const comic = bItem.comic || bItem;
      const pw = await extractPathWord(bItem, comic, true);
      if (!pw) continue;
      const url = `/comic/${pw}`;

      const chUuid = bItem.chapter_id || bItem.chapter_uuid || (bItem.chapter && (bItem.chapter.uuid || bItem.chapter.id));
      const chName = repairMojibake(bItem.chapter_name || (bItem.chapter && bItem.chapter.name) || "阅读历史");
      const readTime = parseDateTimeToMs(bItem.last_read_time || bItem.browse_time || bItem.datetime_updated);
      const chUrl = chUuid ? `/comic/${pw}/chapter/${chUuid}` : url;

      let manga = mangaByUrl.get(url);
      if (!manga) {
        const { title, author, cover } = deriveComicFields(comic);
        manga = makeMangaRecord({
          pw, title, author, cover, status: 1, dateAdded: readTime,
          favorite: false,
          categories: []
        });
        mangaByUrl.set(url, manga);
      }

      if (chUuid) {
        const chNum = parseChapterNumber(chName);
        manga.chapters = [makeChapterRecord({ url: chUrl, name: chName, dateFetch: readTime, dateUpload: readTime, chapterNumber: chNum })];
        manga.history = [{ url: chUrl, lastRead: readTime, readDuration: 0 }];
      }
    }

    const categories = [];
    if (catOrders.length > 0) {
      categories.push({ name: categoryName, id: 1, order: 0, flags: 0 });
    }

    const sources = [{
      name: DEFAULT_COPYMANGA_SOURCE_NAME,
      sourceId: getSourceIdLong(DEFAULT_COPYMANGA_SOURCE_ID)
    }];

    return {
      backupManga: Array.from(mangaByUrl.values()),
      backupCategories: categories,
      backupSources: sources
    };
  }

  // --- Merger Engine ---
  async function mergeWithLocalBackup(existingBackup, subscriptions, historyList, categoryName = "拷贝漫画") {
    const stats = {
      updated_favorites: 0,
      new_manga_added: 0,
      updated_history: 0,
      chapters_marked_read: 0
    };

    // 1. Categories
    let targetCatOrder = null;
    if (categoryName && categoryName.toLowerCase() !== 'none') {
      const existingCat = existingBackup.backupCategories.find(c => c.name.trim().toLowerCase() === categoryName.trim().toLowerCase());
      if (existingCat) {
        targetCatOrder = existingCat.order;
      } else {
        const maxOrder = existingBackup.backupCategories.reduce((max, c) => Math.max(max, c.order || 0), -1);
        targetCatOrder = maxOrder + 1;
        existingBackup.backupCategories.push({
          name: categoryName.trim(),
          order: targetCatOrder,
          id: existingBackup.backupCategories.length + 1,
          flags: 0
        });
      }
    }

    // 2. Index existing CopyManga entries by path_word / URL
    const mangaByPathWord = new Map();
    for (const m of existingBackup.backupManga) {
      if (m.title) m.title = repairMojibake(m.title);
      if (m.author) m.author = repairMojibake(m.author);
      for (const ch of (m.chapters || [])) {
        if (ch.name) ch.name = repairMojibake(ch.name);
      }

      if (String(m.source) === String(DEFAULT_COPYMANGA_SOURCE_ID)) {
        const match = m.url.match(/\/comic\/([^/?#]+)/);
        const pw = match ? match[1].toLowerCase() : m.url.toLowerCase();
        mangaByPathWord.set(pw, m);
      }
    }

    // Per-manga chapter index (built lazily, keyed by manga object identity)
    // so repeated history hits against the same manga are O(1) instead of a
    // fresh linear scan each time.
    const chapterIndexCache = new Map();
    function getChapterIndex(manga) {
      if (chapterIndexCache.has(manga)) return chapterIndexCache.get(manga);
      const byUuid = new Map();
      const byNumber = new Map();
      for (const ch of manga.chapters || []) {
        const uuid = extractChapterUuidFromUrl(ch.url);
        if (uuid) byUuid.set(uuid, ch);
        if (!byNumber.has(ch.chapterNumber)) byNumber.set(ch.chapterNumber, ch);
      }
      const index = { byUuid, byNumber };
      chapterIndexCache.set(manga, index);
      return index;
    }
    function invalidateChapterIndex(manga) {
      chapterIndexCache.delete(manga);
    }

    // 3. Merge Subscriptions
    for (const item of subscriptions) {
      const comic = item.comic || item;
      const pw = await extractPathWord(item, comic, true);
      if (!pw) continue;
      const pwLower = pw.toLowerCase();

      if (mangaByPathWord.has(pwLower)) {
        const m = mangaByPathWord.get(pwLower);
        if (!m.favorite) {
          m.favorite = true;
          stats.updated_favorites++;
        }
        if (targetCatOrder !== null && !(m.categories || []).includes(targetCatOrder)) {
          m.categories = m.categories || [];
          m.categories.push(targetCatOrder);
        }
      } else {
        const { title, author, cover, status } = deriveComicFields(comic);
        const dateAdded = parseDateTimeToMs(item.datetime_created || item.last_updatetime);

        const newManga = makeMangaRecord({
          pw, title, author, cover, status, dateAdded,
          favorite: true,
          categories: targetCatOrder !== null ? [targetCatOrder] : []
        });
        existingBackup.backupManga.push(newManga);
        mangaByPathWord.set(pwLower, newManga);
        stats.new_manga_added++;
      }
    }

    // 4. Merge Reading History
    for (const bItem of historyList) {
      const comic = bItem.comic || bItem;
      const pw = await extractPathWord(bItem, comic, true);
      if (!pw) continue;
      const pwLower = pw.toLowerCase();

      const chUuid = bItem.chapter_id || bItem.chapter_uuid || (bItem.chapter && (bItem.chapter.uuid || bItem.chapter.id));
      const chName = repairMojibake(bItem.chapter_name || (bItem.chapter && bItem.chapter.name) || "阅读历史");
      const readTime = parseDateTimeToMs(bItem.last_read_time || bItem.browse_time || bItem.datetime_updated);
      const chUrl = chUuid ? `/comic/${pw}/chapter/${chUuid}` : `/comic/${pw}`;

      if (mangaByPathWord.has(pwLower)) {
        const m = mangaByPathWord.get(pwLower);
        stats.updated_history++;

        if (m.chapters && m.chapters.length > 0) {
          const { byUuid, byNumber } = getChapterIndex(m);
          let matchedCh = chUuid ? byUuid.get(chUuid) : null;
          if (!matchedCh && chName) {
            const val = parseChapterNumber(chName);
            matchedCh = byNumber.get(val);
          }

          if (matchedCh) {
            if (!matchedCh.read) {
              matchedCh.read = true;
              stats.chapters_marked_read++;
            }
            matchedCh.lastPageRead = 1;
            const existingHist = (m.history || []).find(h => h.url === matchedCh.url);
            if (existingHist) {
              if (readTime > existingHist.lastRead) existingHist.lastRead = readTime;
            } else {
              m.history = m.history || [];
              m.history.push({ url: matchedCh.url, lastRead: readTime, readDuration: 0 });
            }
          }
        } else if (chUuid) {
          const chNum = parseChapterNumber(chName);
          m.chapters = [makeChapterRecord({ url: chUrl, name: chName, dateFetch: readTime, dateUpload: readTime, chapterNumber: chNum })];
          m.history = [{ url: chUrl, lastRead: readTime, readDuration: 0 }];
          invalidateChapterIndex(m);
        }
      } else {
        if (chUuid) {
          const { title, cover } = deriveComicFields(comic);
          const chNum = parseChapterNumber(chName);

          const newManga = makeMangaRecord({
            pw, title, author: "", cover, status: 1, dateAdded: readTime,
            favorite: false,
            categories: []
          });
          newManga.chapters = [makeChapterRecord({ url: chUrl, name: chName, dateFetch: readTime, dateUpload: readTime, chapterNumber: chNum })];
          newManga.history = [{ url: chUrl, lastRead: readTime, readDuration: 0 }];

          existingBackup.backupManga.push(newManga);
          mangaByPathWord.set(pwLower, newManga);
          stats.new_manga_added++;
          stats.updated_history++;
        }
      }
    }

    return { mergedBackup: existingBackup, stats };
  }

  // --- Download / Notification Helpers ---
  function fallbackDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function downloadBlob(blob, filename) {
    // Prefer GM_download: it is handled by the userscript manager itself and
    // isn't subject to the page's own CSP (some manga sites block blob: URL
    // navigation / anchor downloads), so it's more reliable when available.
    if (typeof GM_download === 'function') {
      const url = URL.createObjectURL(blob);
      try {
        GM_download({
          url,
          name: filename,
          saveAs: false,
          onload: () => URL.revokeObjectURL(url),
          onerror: () => {
            URL.revokeObjectURL(url);
            fallbackDownload(blob, filename);
          }
        });
        return;
      } catch (_) {
        URL.revokeObjectURL(url);
      }
    }
    fallbackDownload(blob, filename);
  }

  function notifyUser(title, text) {
    if (typeof GM_notification === 'function') {
      try {
        GM_notification({ title, text, timeout: 6000 });
        return;
      } catch (_) { }
    }
    alert(`${title}\n${text}`);
  }

  function serializeAndDownloadTachibk(backupObj, filename) {
    const Backup = initProtobuf();
    const errMsg = Backup.verify(backupObj);
    if (errMsg) throw new Error("Protobuf 校验失败: " + errMsg);

    const message = Backup.create(backupObj);
    const protoBytes = Backup.encode(message).finish();
    const gzippedBytes = window.pako.gzip(protoBytes);

    const blob = new Blob([gzippedBytes], { type: 'application/octet-stream' });
    downloadBlob(blob, filename);
  }

  // --- UI Components & Styles (Pure Element UI Native Style) ---
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* Top Slim Progress Bar (YouTube style) */
      #c2m-top-progress {
        position: fixed;
        top: 0;
        left: 0;
        height: 2px;
        width: 0%;
        background: #1790e6;
        z-index: 1000000;
        transition: width 0.25s ease, opacity 0.4s ease;
        pointer-events: none;
      }

      /* Personal Center Header Actions (Inside blue card below registration date) */
      .c2m-person-header-actions {
        margin-top: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .c2m-person-btn {
        display: inline-block;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        background: #ffffff;
        border: 1px solid #dcdfe6;
        color: #1790e6;
        -webkit-appearance: none;
        text-align: center;
        box-sizing: border-box;
        outline: none;
        margin: 0;
        transition: .1s;
        font-weight: 500;
        padding: 7px 15px;
        font-size: 12px;
        border-radius: 4px;
      }
      .c2m-person-btn:hover {
        background: #ecf5ff;
        border-color: #c6e2ff;
        color: #1790e6;
      }
      .c2m-person-btn-sub {
        background: transparent;
        border-color: #ffffff;
        color: #ffffff;
      }
      .c2m-person-btn-sub:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: #ffffff;
        color: #ffffff;
      }

      /* Native Nav Item */
      .c2m-native-nav-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        margin: 0 4px;
        font-size: 13.5px;
        font-weight: 500;
        color: inherit;
        background: transparent;
        border: 1px solid #dcdfe6;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.15s ease;
        text-decoration: none;
        user-select: none;
        line-height: normal;
        vertical-align: middle;
      }
      .c2m-native-nav-btn:hover {
        color: #1790e6 !important;
        border-color: #1790e6;
        background: #ecf5ff;
      }

      /* Modal Overlay (Element UI dialog wrapper) */
      #c2m-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.5);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 999999;
      }

      /* Modal Card (Element UI dialog) */
      #c2m-modal-card {
        position: relative;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 4px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        box-sizing: border-box;
        width: 440px;
        max-width: 92vw;
        font-family: inherit;
      }

      .c2m-modal-header {
        padding: 20px 20px 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .c2m-modal-title {
        line-height: 24px;
        font-size: 18px;
        color: #303133;
        font-weight: 500;
      }
      .c2m-close-btn {
        position: absolute;
        top: 20px;
        right: 20px;
        padding: 0;
        background: transparent;
        border: none;
        outline: none;
        cursor: pointer;
        font-size: 16px;
        color: #909399;
      }
      .c2m-close-btn:hover {
        color: #1790e6;
      }

      .c2m-modal-body {
        padding: 15px 20px 25px;
        color: #606266;
        font-size: 14px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .c2m-btn-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .c2m-btn {
        display: inline-block;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        background: #ffffff;
        border: 1px solid #dcdfe6;
        color: #606266;
        text-align: center;
        box-sizing: border-box;
        outline: none;
        margin: 0;
        transition: .1s;
        font-weight: 500;
        padding: 10px 18px;
        font-size: 13.5px;
        border-radius: 4px;
      }
      .c2m-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .c2m-btn-full {
        grid-column: span 2;
      }
      
      .c2m-btn-main {
        color: #ffffff;
        background-color: #1790e6;
        border-color: #1790e6;
      }
      .c2m-btn-main:hover:not(:disabled) {
        background: #3b9fe9;
        border-color: #3b9fe9;
        color: #ffffff;
      }

      .c2m-btn-sub {
        background: #ffffff;
        border-color: #dcdfe6;
        color: #606266;
      }
      .c2m-btn-sub:hover:not(:disabled) {
        color: #1790e6;
        border-color: #c6e2ff;
        background-color: #ecf5ff;
      }

      .c2m-btn-emerald {
        color: #ffffff;
        background-color: #67c23a;
        border-color: #67c23a;
      }
      .c2m-btn-emerald:hover:not(:disabled) {
        background: #85ce61;
        border-color: #85ce61;
        color: #ffffff;
      }

      .c2m-opt-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 13px;
        color: #606266;
        margin-top: 4px;
      }
      .c2m-text-input {
        -webkit-appearance: none;
        background-color: #ffffff;
        border-radius: 4px;
        border: 1px solid #dcdfe6;
        box-sizing: border-box;
        color: #606266;
        display: inline-block;
        font-size: inherit;
        height: 32px;
        line-height: 32px;
        outline: none;
        padding: 0 12px;
        transition: border-color .2s cubic-bezier(.645,.045,.355,1);
        width: 140px;
      }
      .c2m-text-input:focus {
        border-color: #1790e6;
      }

      .c2m-progress-panel {
        display: none;
        flex-direction: column;
        gap: 6px;
        margin-top: 4px;
      }
      .c2m-meter-bg {
        height: 6px;
        background: #ebeef5;
        border-radius: 100px;
        overflow: hidden;
        position: relative;
        vertical-align: middle;
      }
      .c2m-meter-fill {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background-color: #1790e6;
        text-align: right;
        border-radius: 100px;
        line-height: 1;
        white-space: nowrap;
        transition: width .3s ease;
      }
      .c2m-progress-info {
        font-size: 12px;
        color: #909399;
        display: flex;
        justify-content: space-between;
      }

      .c2m-log-terminal {
        font-size: 12px;
        color: #606266;
        background: #f5f7fa;
        border: 1px solid #e4e7ed;
        border-radius: 4px;
        padding: 10px;
        max-height: 90px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  const UI = {};

  function openModal() {
    if (UI.overlay) {
      UI.overlay.style.display = 'flex';
    }
  }

  function closeModal() {
    if (UI.overlay) {
      UI.overlay.style.display = 'none';
    }
  }

  function createUI() {
    if (document.getElementById('c2m-modal-overlay')) return; // already injected

    injectStyles();

    // Top slim progress bar
    const topProgress = document.createElement('div');
    topProgress.id = 'c2m-top-progress';
    document.body.appendChild(topProgress);

    // Centered Modal Dialog (Element UI dialog)
    const overlay = document.createElement('div');
    overlay.id = 'c2m-modal-overlay';
    overlay.innerHTML = `
      <div id="c2m-modal-card">
        <div class="c2m-modal-header">
          <div class="c2m-modal-title">导出到 Mihon</div>
          <button type="button" class="c2m-close-btn" id="c2m-close-modal">✕</button>
        </div>
        <div class="c2m-modal-body">
          <div class="c2m-btn-grid">
            <button class="c2m-btn c2m-btn-main c2m-btn-full" id="c2m-export-all">
              导出完整备份 (书架与历史)
            </button>
            <button class="c2m-btn c2m-btn-sub" id="c2m-export-subs">仅导出书架</button>
            <button class="c2m-btn c2m-btn-sub" id="c2m-export-hist">仅导出历史</button>
            <button class="c2m-btn c2m-btn-emerald c2m-btn-full" id="c2m-merge-btn">
              合并到本地备份 (.tachibk)
            </button>
          </div>
          <input type="file" id="c2m-file-input" accept=".tachibk" style="display:none;" />

          <div class="c2m-opt-row">
            <span>分类名称:</span>
            <input type="text" class="c2m-text-input" id="c2m-category-input" value="拷贝漫画" />
          </div>

          <div class="c2m-progress-panel" id="c2m-progress-box">
            <div class="c2m-meter-bg">
              <div class="c2m-meter-fill" id="c2m-progress-fill"></div>
            </div>
            <div class="c2m-progress-info">
              <span id="c2m-progress-msg">准备就绪</span>
              <span id="c2m-progress-count">0%</span>
            </div>
          </div>

          <div class="c2m-log-terminal" id="c2m-log-box"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Cache refs
    UI.topProgress = topProgress;
    UI.overlay = overlay;
    UI.exportAllBtn = document.getElementById('c2m-export-all');
    UI.exportSubsBtn = document.getElementById('c2m-export-subs');
    UI.exportHistBtn = document.getElementById('c2m-export-hist');
    UI.mergeBtn = document.getElementById('c2m-merge-btn');
    UI.fileInput = document.getElementById('c2m-file-input');
    UI.categoryInput = document.getElementById('c2m-category-input');
    UI.progressBox = document.getElementById('c2m-progress-box');
    UI.progressFill = document.getElementById('c2m-progress-fill');
    UI.progressMsg = document.getElementById('c2m-progress-msg');
    UI.progressCount = document.getElementById('c2m-progress-count');
    UI.logBox = document.getElementById('c2m-log-box');

    // Event Bindings
    document.getElementById('c2m-close-modal').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') {
        closeModal();
      }
    });

    UI.exportAllBtn.addEventListener('click', () => runExportPipeline(true, true));
    UI.exportSubsBtn.addEventListener('click', () => runExportPipeline(true, false));
    UI.exportHistBtn.addEventListener('click', () => runExportPipeline(false, true));

    UI.mergeBtn.addEventListener('click', () => UI.fileInput.click());
    UI.fileInput.addEventListener('change', handleMergeFileSelected);

    // Register Native Menu Commands in Tampermonkey
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand("打开导出面板", openModal);
      GM_registerMenuCommand("导出完整备份", () => { openModal(); runExportPipeline(true, true); });
      GM_registerMenuCommand("合并本地备份", () => { openModal(); UI.fileInput.click(); });
    }

    // Try injecting native buttons into page navbar and bookshelf
    injectNativePageButtons();
  }

  // Inject buttons into native CopyManga navbar and personal center
  function injectNativePageButtons() {
    // 1. Personal Center Header Banner (https://www.mangacopy.com/web/person/*)
    const avatarEl = document.querySelector('header .vavtar, .vavtar, header .el-avatar, .el-avatar--square');
    if (avatarEl && avatarEl.parentElement) {
      const infoContainer = avatarEl.parentElement;
      if (!infoContainer.querySelector('#c2m-person-header-actions')) {
        // Clean up any stray actions appended elsewhere
        document.querySelectorAll('#c2m-person-header-actions').forEach(el => el.remove());

        const actionSection = document.createElement('section');
        actionSection.id = 'c2m-person-header-actions';
        actionSection.className = 'c2m-person-header-actions';

        const exportBtn = document.createElement('button');
        exportBtn.className = 'c2m-person-btn';
        exportBtn.innerHTML = '导出到 Mihon';
        exportBtn.title = '导出书架与历史记录至 Mihon 备份';
        exportBtn.addEventListener('click', openModal);

        actionSection.appendChild(exportBtn);
        infoContainer.appendChild(actionSection);
      }
    }

    // 2. Main Site Top Navbar (Home, Comic detail, etc.)
    const navTargets = [
      '.nav-list',
      '.header-content ul',
      '.navbar-nav',
      '.header ul',
      '.user-box',
      '.header .right',
      '.header-right',
      '.nav-content'
    ];

    let navContainer = null;
    for (const sel of navTargets) {
      const el = document.querySelector(sel);
      if (el) {
        navContainer = el;
        break;
      }
    }

    if (navContainer && !document.getElementById('c2m-nav-injected-btn')) {
      const btn = document.createElement('a');
      btn.id = 'c2m-nav-injected-btn';
      btn.className = 'c2m-native-nav-btn';
      btn.href = 'javascript:void(0);';
      btn.innerHTML = '导出到 Mihon';
      btn.title = '导出书架与历史记录至 Mihon 备份';
      btn.addEventListener('click', openModal);

      const li = document.createElement('li');
      li.id = 'c2m-nav-li';
      li.style.display = 'inline-flex';
      li.style.alignItems = 'center';
      li.appendChild(btn);
      navContainer.appendChild(li);
    }
  }

  function logMessage(msg) {
    if (!UI.logBox) return;
    UI.logBox.style.display = 'block';
    UI.logBox.textContent += msg + '\n';
    UI.logBox.scrollTop = UI.logBox.scrollHeight;
  }

  function setProgress(msg, percent = 0) {
    const p = Math.min(100, Math.max(0, percent));
    if (UI.topProgress) {
      UI.topProgress.style.opacity = p > 0 && p < 100 ? '1' : (p === 100 ? '1' : '0');
      UI.topProgress.style.width = `${p}%`;
      if (p === 100) {
        setTimeout(() => { if (UI.topProgress) UI.topProgress.style.opacity = '0'; }, 800);
      }
    }
    if (UI.progressBox) UI.progressBox.style.display = 'flex';
    if (UI.progressFill) UI.progressFill.style.width = `${p}%`;
    if (UI.progressMsg) UI.progressMsg.textContent = msg;
    if (UI.progressCount) UI.progressCount.textContent = `${Math.round(p)}%`;
  }

  // --- Pipeline Executions ---
  async function runExportPipeline(includeSubs, includeHist) {
    const token = detectedToken || detectTokenFromStorage();
    if (!token) {
      alert("未检测到登录信息，请先在当前网站登录账号后再导出。");
      return;
    }

    const catName = UI.categoryInput?.value || "拷贝漫画";
    if (UI.logBox) { UI.logBox.textContent = ''; UI.logBox.style.display = 'none'; }

    try {
      let subs = [];
      let hist = [];

      if (includeSubs) {
        setProgress("正在获取书架数据...", 10);
        subs = await fetchAllSubscriptions(token, (cur, total) => {
          const pct = Math.round((cur / (total || 1)) * 40) + 10;
          setProgress(`正在获取书架数据 (${cur}/${total})...`, pct);
        });
        logMessage(`已获取 ${subs.length} 本书架漫画`);
      }

      if (includeHist) {
        setProgress("正在获取历史数据...", 50);
        hist = await fetchAllReadingHistory(token, (cur, total) => {
          const pct = Math.round((cur / (total || 1)) * 40) + 50;
          setProgress(`正在获取历史数据 (${cur}/${total})...`, pct);
        });
        logMessage(`已获取 ${hist.length} 条历史记录`);
      }

      setProgress("正在生成备份文件...", 95);
      const backup = await convertToMihonBackup(subs, hist, catName);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const filename = `copymanga_backup_${timestamp}.tachibk`;
      serializeAndDownloadTachibk(backup, filename);

      setProgress("导出完成，正在下载", 100);
      logMessage(`备份已生成: ${filename} (共 ${backup.backupManga.length} 本)`);
      notifyUser("Mihon 备份已生成", `${filename} (共 ${backup.backupManga.length} 本)`);
    } catch (err) {
      logMessage("导出失败: " + err.message);
      setProgress("导出失败", 0);
      notifyUser("导出失败", err.message);
    }
  }

  async function handleMergeFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    const token = detectedToken || detectTokenFromStorage();
    if (!token) {
      alert("未检测到登录信息，请先在当前网站登录账号后再导出。");
      e.target.value = '';
      return;
    }

    const catName = UI.categoryInput?.value || "拷贝漫画";
    if (UI.logBox) { UI.logBox.textContent = ''; UI.logBox.style.display = 'none'; }

    try {
      setProgress("正在读取本地备份...", 10);
      const arrayBuffer = await file.arrayBuffer();
      const unzippedBytes = window.pako.ungzip(new Uint8Array(arrayBuffer));

      const Backup = initProtobuf();
      const existingBackup = Backup.decode(unzippedBytes);
      logMessage(`已读取本地备份 (原有 ${existingBackup.backupManga.length} 本漫画)`);

      setProgress("正在获取云端书架数据...", 30);
      const subs = await fetchAllSubscriptions(token, (cur, total) => {
        setProgress(`正在获取书架数据 (${cur}/${total})...`, 30 + Math.round((cur / (total || 1)) * 25));
      });

      setProgress("正在获取云端历史数据...", 60);
      const hist = await fetchAllReadingHistory(token, (cur, total) => {
        setProgress(`正在获取历史数据 (${cur}/${total})...`, 60 + Math.round((cur / (total || 1)) * 25));
      });

      setProgress("正在合并数据...", 90);
      const { mergedBackup, stats } = await mergeWithLocalBackup(existingBackup, subs, hist, catName);

      const outName = file.name.replace(/\.tachibk$/i, '') + '_merged.tachibk';
      serializeAndDownloadTachibk(mergedBackup, outName);

      setProgress("合并完成，正在下载", 100);
      logMessage(`合并完成: ${outName}`);
      logMessage(`  - 新增漫画: ${stats.new_manga_added} 本`);
      logMessage(`  - 更新书架: ${stats.updated_favorites} 本`);
      logMessage(`  - 标记已读: ${stats.chapters_marked_read} 话`);
      logMessage(`  - 更新历史: ${stats.updated_history} 条`);
      notifyUser("Mihon 备份合并完成", `${outName}\n新增 ${stats.new_manga_added} 本，标记已读 ${stats.chapters_marked_read} 话`);
    } catch (err) {
      logMessage("合并失败: " + err.message);
      setProgress("合并失败", 0);
      notifyUser("合并失败", err.message);
    } finally {
      e.target.value = '';
    }
  }

  // --- Initialize ---
  installNetworkHooks();

  function onInit() {
    createUI();

    // Periodic check on startup
    let pollCount = 0;
    const pollInterval = setInterval(() => {
      pollCount++;
      detectTokenFromStorage();
      injectNativePageButtons();
      if (pollCount >= 15) clearInterval(pollInterval);
    }, 1000);

    // MutationObserver to watch for Vue router page changes and inject buttons dynamically
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        injectNativePageButtons();
        detectTokenFromStorage();
      }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onInit);
  } else {
    onInit();
  }

})();