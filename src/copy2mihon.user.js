// ==UserScript==
// @name         copy2mihon - 拷贝漫画转 Mihon 备份工具
// @namespace    https://github.com/taffy/copy2mihon
// @version      0.5.0
// @description  在浏览器中一键导出拷贝漫画书架订阅与阅读历史至 Mihon / Tachiyomi / Komikku 备份 (.tachibk)，支持双向增量合并
// @author       Taffy
// @match        *://*.mangacopy.com/*
// @match        *://*.copy4000.com/*
// @match        *://*.2026copy.com/*
// @match        *://*.copymanga.tv/*
// @match        *://*.copymanga.site/*
// @match        *://*.copymanga.org/*
// @match        *://*.copymanga.com/*
// @require      https://cdn.jsdelivr.net/npm/long@5.2.3/umd/index.js
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

  // --- Protobuf Schema Definition (Mihon v0.21.x backup format) ---
  // Field numbers must match Mihon's Backup* models exactly. Everything is
  // declared optional so decode -> merge -> encode never trips over fields
  // omitted by older backups or by Mihon's encodeDefaults=false writer.
  const PROTO_DEFINITION = `
    syntax = "proto2";

    message Backup {
      repeated BackupManga backupManga = 1;
      repeated BackupCategory backupCategories = 2;
      repeated BackupSource backupSources = 101;
      repeated BackupPreference backupPreferences = 104;
      repeated BackupSourcePreferences backupSourcePreferences = 105;
      repeated BackupExtensionStore backupExtensionStores = 106;
    }

    message BackupManga {
      optional int64 source = 1;
      optional string url = 2;
      optional string title = 3 [default = ""];
      optional string artist = 4;
      optional string author = 5;
      optional string description = 6;
      repeated string genre = 7;
      optional int32 status = 8 [default = 0];
      optional string thumbnailUrl = 9;
      optional int64 dateAdded = 13 [default = 0];
      optional int32 viewer = 14 [default = 0];
      repeated BackupChapter chapters = 16;
      repeated int64 categories = 17;
      repeated BackupTracking tracking = 18;
      optional bool favorite = 100 [default = true];
      optional int32 chapterFlags = 101 [default = 0];
      optional int32 viewerFlags = 103;
      repeated BackupHistory history = 104;
      optional int32 updateStrategy = 105 [default = 0];
      // Abandoned in Mihon but still written by Komikku; kept as passthrough.
      optional int64 lastModifiedAt = 106;
      optional int64 favoriteModifiedAt = 107;
      repeated string excludedScanlators = 108;
      optional int64 version = 109;
      optional string notes = 110 [default = ""];
      optional bool initialized = 111 [default = false];
      optional bytes memo = 112;
      optional int64 nextUpdate = 113 [default = 0];
    }

    message BackupChapter {
      optional string url = 1;
      optional string name = 2;
      optional string scanlator = 3;
      optional bool read = 4 [default = false];
      optional bool bookmark = 5 [default = false];
      optional int64 lastPageRead = 6 [default = 0];
      optional int64 dateFetch = 7 [default = 0];
      optional int64 dateUpload = 8 [default = 0];
      optional float chapterNumber = 9 [default = 0];
      optional int64 sourceOrder = 10 [default = 0];
      // Abandoned in Mihon but still written by Komikku; kept as passthrough.
      optional int64 lastModifiedAt = 11;
      optional int64 version = 12;
      optional bytes memo = 13;
    }

    message BackupCategory {
      optional string name = 1;
      optional int64 order = 2 [default = 0];
      optional int64 id = 3 [default = 0];
      optional int64 flags = 100 [default = 0];
    }

    message BackupHistory {
      optional string url = 1;
      optional int64 lastRead = 2;
      optional int64 readDuration = 3 [default = 0];
    }

    message BackupSource {
      optional string name = 1;
      optional int64 sourceId = 2;
    }

    message BackupTracking {
      optional int32 syncId = 1;
      optional int64 libraryId = 2;
      optional int32 mediaIdInt = 3 [default = 0];
      optional string trackingUrl = 4 [default = ""];
      optional string title = 5 [default = ""];
      optional float lastChapterRead = 6 [default = 0];
      optional int32 totalChapters = 7 [default = 0];
      optional float score = 8 [default = 0];
      optional int32 status = 9 [default = 0];
      optional int64 startedReadingDate = 10 [default = 0];
      optional int64 finishedReadingDate = 11 [default = 0];
      optional bool private = 12 [default = false];
      optional int64 mediaId = 100 [default = 0];
    }

    message BackupPreference {
      optional string key = 1;
      optional PreferenceValue value = 2;
    }

    // kotlinx.serialization stores the sealed PreferenceValue union as
    // { type: <subclass name>, truevalue: <encoded value> }.
    message PreferenceValue {
      optional string type = 1;
      optional bytes truevalue = 2;
    }

    message BackupSourcePreferences {
      optional string sourceKey = 1;
      repeated BackupPreference prefs = 2;
    }

    message BackupExtensionStore {
      optional string indexUrl = 1;
      optional string name = 2;
      optional string badgeLabel = 3;
      optional string signingKey = 5;
      optional string contactWebsite = 4;
      optional string contactDiscord = 6;
      optional bool isLegacy = 7;
      optional string extensionListUrl = 8;
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

  // Empty JsonObject memo ("{}"), reused for every generated record.
  const EMPTY_MEMO_BYTES = new TextEncoder().encode("{}");

  // protobufjs decodes int64 as Long instances, so numeric fields coming back
  // from an existing backup need explicit conversion before ===/includes().
  function toNumber(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return value;
    if (typeof value.toNumber === "function") return value.toNumber();
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  // protobufjs shares one default empty array between every decoded message of
  // a type; arrays that get appended to must be own properties.
  function ownArray(obj, key) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = [];
    return obj[key];
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
    } catch (_) { }
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
        } catch (_) { }
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
      } catch (_) { }
    }

    // 4. Try GM_cookie if available in extension
    if (typeof GM_cookie !== 'undefined' && typeof GM_cookie.list === 'function') {
      try {
        GM_cookie.list({ name: 'token' }, function (cookies, error) {
          if (!error && cookies && cookies.length > 0) {
            const tok = cleanToken(cookies[0].value);
            if (tok.length >= 20 && tok !== detectedToken) {
              detectedToken = tok;
            }
          }
        });
      } catch (_) { }
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
                }
              }
            }
            return origFetch.apply(this, arguments);
          };
          hookedFetch._c2m_hooked = true;
          win.fetch = hookedFetch;
        }
      } catch (_) { }
    }
  }

  // --- Cleaners and Helpers ---
  async function sha1Hex(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Codepoint mapping for Windows-1252 characters that latin1 cannot encode.
  const CP1252_REVERSE_MAP = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };
  const MOJIBAKE_MARKERS = new Set(
    ["ç", "¬", "å", "Ã", "Â", "é", "è", "æ", "§", "°", "¶", "·", "ä", "¸", "Š", "œ"]
  );
  const MOJIBAKE_REPLACEMENTS = {
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

  function repairMojibake(text) {
    if (!text) return "";
    const value = String(text);

    let hasMarker = false;
    for (const ch of value) {
      if (MOJIBAKE_MARKERS.has(ch)) { hasMarker = true; break; }
    }
    if (!hasMarker) return value;

    // Rebuild the original bytes, then decode as UTF-8. CopyManga sometimes
    // returns UTF-8 that was decoded as Latin-1/CP1252, including mixed
    // strings like "ç¬¬01å\x8D·" where hand-written replacements alone fail.
    const bytes = [];
    for (const ch of value) {
      const code = ch.codePointAt(0);
      const mapped = code < 256 ? code : CP1252_REVERSE_MAP[code];
      if (mapped === undefined) { bytes.length = 0; break; }
      bytes.push(mapped);
    }
    if (bytes.length > 0) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      } catch (_) { }
    }

    let res = value;
    for (const [k, v] of Object.entries(MOJIBAKE_REPLACEMENTS)) {
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
    return pw.toLowerCase();
  }

  function parseDateTimeToMs(dateVal, fallback = null) {
    if (dateVal === null || dateVal === undefined || dateVal === "") return fallback;

    if (typeof dateVal === "number" && isFinite(dateVal)) {
      return dateVal < 100000000000 ? dateVal * 1000 : dateVal;
    }

    if (typeof dateVal === "string") {
      const trimmed = dateVal.trim();
      if (!trimmed) return fallback;

      if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        return num < 100000000000 ? num * 1000 : num;
      }

      // CopyManga sends naive Beijing time (UTC+8) without an offset.
      const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
      let isoish = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
      if (!hasZone) {
        isoish = /^\d{4}-\d{2}-\d{2}$/.test(isoish)
          ? `${isoish}T00:00:00+08:00`
          : `${isoish}+08:00`;
      }
      const parsed = Date.parse(isoish);
      if (!isNaN(parsed)) return parsed;
    }

    return fallback;
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
      chapterFlags: 0,
      viewerFlags: 0,
      categories,
      chapters: [],
      history: [],
      memo: EMPTY_MEMO_BYTES
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
      memo: EMPTY_MEMO_BYTES
    };
  }

  function statusFromText(text) {
    const value = String(text || "").trim().toLowerCase();
    if (!value) return null;
    if (
      value.includes("完结") || value.includes("完結") ||
      ["completed", "complete", "finished", "ended", "end"].includes(value)
    ) return 2;
    if (
      value.includes("连载") || value.includes("連載") ||
      ["ongoing", "publishing", "serialization", "serializing"].includes(value)
    ) return 1;
    return null;
  }

  // CopyManga v3 returns status as { value, display }; older payloads use a
  // bare int/string. The display text is the most reliable signal.
  function normalizeComicStatus(status, statusStr) {
    if (status && typeof status === "object") {
      const byDisplay = statusFromText(status.display || status.name);
      if (byDisplay !== null) return byDisplay;
      status = status.value !== undefined ? status.value : status.id;
    }

    if (typeof status === "number" && isFinite(status)) {
      const num = Math.trunc(status);
      if (num === 0) return 1;
      if (num === 1 || num === 2) return 2;
      return 1;
    }

    const text = typeof status === "string" ? status.trim() : "";
    if (/^\d+$/.test(text)) return normalizeComicStatus(Number(text), statusStr);
    const byText = statusFromText(text);
    if (byText !== null) return byText;
    const byStr = statusFromText(statusStr);
    return byStr !== null ? byStr : 1;
  }

  function extractAuthor(authorField) {
    if (!authorField) return "";
    if (typeof authorField === "string") return repairMojibake(authorField.trim());
    if (!Array.isArray(authorField)) return "";
    return authorField
      .map(a => repairMojibake(typeof a === "string" ? a : (a && a.name) || "").trim())
      .filter(Boolean)
      .join(", ");
  }

  function deriveComicFields(comic) {
    const title = repairMojibake(comic.name || comic.title || "Unknown");
    const author = extractAuthor(comic.author);
    const cover = comic.cover || "";
    const status = normalizeComicStatus(comic.status, comic.status_str);
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
      const dateAdded = parseDateTimeToMs(
        item.datetime_modifier || item.datetime_created || item.last_updatetime ||
        comic.datetime_updated || comic.datetime_created,
        Date.now()
      );

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

      const chUuid = bItem.chapter_id || bItem.chapter_uuid || bItem.last_chapter_id ||
        (bItem.chapter && (bItem.chapter.uuid || bItem.chapter.id));
      const chName = repairMojibake(
        bItem.chapter_name || bItem.last_chapter_name || (bItem.chapter && bItem.chapter.name) || "阅读历史"
      ).trim() || "阅读历史";
      const readTime = parseDateTimeToMs(
        bItem.datetime_modifier || bItem.last_read_time || bItem.browse_time ||
        bItem.datetime_updated || comic.datetime_updated || comic.datetime_created,
        Date.now()
      );
      const chUrl = chUuid ? `/comic/${pw}/chapter/${chUuid}` : url;

      let manga = mangaByUrl.get(url);
      if (!manga) {
        const { title, author, cover, status } = deriveComicFields(comic);
        manga = makeMangaRecord({
          pw, title, author, cover, status, dateAdded: readTime,
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

    const mangaList = ownArray(existingBackup, "backupManga");
    const categoryList = ownArray(existingBackup, "backupCategories");
    const sourceList = ownArray(existingBackup, "backupSources");

    // 1. Categories
    let targetCatOrder = null;
    if (categoryName && categoryName.trim().toLowerCase() !== "none") {
      const wanted = categoryName.trim().toLowerCase();
      const existingCat = categoryList.find(c => (c.name || "").trim().toLowerCase() === wanted);
      if (existingCat) {
        targetCatOrder = toNumber(existingCat.order);
      } else {
        const maxOrder = categoryList.reduce((max, c) => Math.max(max, toNumber(c.order)), -1);
        const maxId = categoryList.reduce((max, c) => Math.max(max, toNumber(c.id)), 0);
        targetCatOrder = maxOrder + 1;
        categoryList.push({
          name: categoryName.trim(),
          order: targetCatOrder,
          id: maxId + 1,
          flags: 0
        });
      }
    }

    // 2. Index existing CopyManga entries by path_word / URL
    const mangaByPathWord = new Map();
    for (const m of mangaList) {
      if (m.title) m.title = repairMojibake(m.title);
      if (m.author) m.author = repairMojibake(m.author);
      for (const ch of (m.chapters || [])) {
        if (ch.name) ch.name = repairMojibake(ch.name);
      }

      if (String(m.source) === String(DEFAULT_COPYMANGA_SOURCE_ID)) {
        const match = (m.url || "").match(/\/comic\/([^/?#]+)/);
        const pw = match ? match[1].toLowerCase() : (m.url || "").toLowerCase();
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
      const add = (map, key, ch) => {
        const list = map.get(key);
        if (list) list.push(ch);
        else map.set(key, [ch]);
      };
      for (const ch of manga.chapters || []) {
        const uuid = extractChapterUuidFromUrl(ch.url);
        if (uuid) add(byUuid, uuid, ch);
        add(byNumber, ch.chapterNumber, ch);
      }
      const index = { byUuid, byNumber };
      chapterIndexCache.set(manga, index);
      return index;
    }

    // Legacy backups can contain the same chapter twice, once with a malformed
    // URL missing the /comic/ prefix. Prefer the canonical row.
    function preferCanonicalChapters(list) {
      return list.slice().sort((a, b) => {
        const aCanon = (a.url || "").startsWith("/comic/") ? 0 : 1;
        const bCanon = (b.url || "").startsWith("/comic/") ? 0 : 1;
        return aCanon - bCanon;
      });
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
        // Mihon omits favorite from the wire when it is true (proto default),
        // so only an explicit false means "not in library".
        if (m.favorite === false) {
          m.favorite = true;
          stats.updated_favorites++;
        }
        // Preserve the user's existing category assignment for manga already in Mihon
      } else {
        const { title, author, cover, status } = deriveComicFields(comic);
        const dateAdded = parseDateTimeToMs(
          item.datetime_modifier || item.datetime_created || item.last_updatetime ||
          comic.datetime_updated || comic.datetime_created,
          Date.now()
        );

        const newManga = makeMangaRecord({
          pw, title, author, cover, status, dateAdded,
          favorite: true,
          categories: targetCatOrder !== null ? [targetCatOrder] : []
        });
        mangaList.push(newManga);
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

      const chUuid = bItem.chapter_id || bItem.chapter_uuid || bItem.last_chapter_id ||
        (bItem.chapter && (bItem.chapter.uuid || bItem.chapter.id));
      const chName = repairMojibake(
        bItem.chapter_name || bItem.last_chapter_name || (bItem.chapter && bItem.chapter.name) || "阅读历史"
      ).trim() || "阅读历史";
      const readTime = parseDateTimeToMs(
        bItem.datetime_modifier || bItem.last_read_time || bItem.browse_time ||
        bItem.datetime_updated || comic.datetime_updated || comic.datetime_created
      );
      const chUrl = chUuid ? `/comic/${pw}/chapter/${chUuid}` : `/comic/${pw}`;
      const chTime = readTime !== null ? readTime : Date.now();

      let m = mangaByPathWord.get(pwLower);
      if (!m) {
        if (!chUuid) continue;
        const { title, author, cover, status } = deriveComicFields(comic);
        m = makeMangaRecord({
          pw, title, author, cover, status, dateAdded: chTime,
          favorite: false,
          categories: []
        });
        mangaList.push(m);
        mangaByPathWord.set(pwLower, m);
        stats.new_manga_added++;
      }

      if (!chUuid) continue;

      let historyUrl = null;
      let changed = false;
      if (m.chapters && m.chapters.length > 0) {
        const { byUuid, byNumber } = getChapterIndex(m);
        let targets = byUuid.get(chUuid) || [];
        if (targets.length === 0 && chName !== "阅读历史") {
          const chNum = parseChapterNumber(chName);
          if (chNum > 0) targets = byNumber.get(chNum) || [];
        }
        targets = preferCanonicalChapters(targets);
        if (targets.length > 0) {
          historyUrl = targets[0].url;
          let marked = false;
          for (const targetCh of targets) {
            if (!targetCh.read) {
              targetCh.read = true;
              if (toNumber(targetCh.lastPageRead) === 0) targetCh.lastPageRead = 1;
              marked = true;
              changed = true;
            }
          }
          if (marked) stats.chapters_marked_read++;
        }
      }

      // The chapter is missing locally (new chapter, renamed URL, or manga
      // with no chapters yet): add it instead of dropping the progress.
      if (!historyUrl) {
        const chapter = makeChapterRecord({
          url: chUrl,
          name: chName,
          dateFetch: chTime,
          dateUpload: chTime,
          chapterNumber: parseChapterNumber(chName)
        });
        ownArray(m, "chapters").push(chapter);
        invalidateChapterIndex(m);
        historyUrl = chapter.url;
        stats.chapters_marked_read++;
        changed = true;
      }

      if (readTime !== null) {
        const history = ownArray(m, "history");
        const historyKey = extractChapterUuidFromUrl(historyUrl);
        const existingHist = history.find(h =>
          h.url === historyUrl ||
          (historyKey && extractChapterUuidFromUrl(h.url) === historyKey)
        );
        if (existingHist) {
          if (readTime > toNumber(existingHist.lastRead)) {
            existingHist.lastRead = readTime;
            changed = true;
          }
        } else {
          history.push({ url: historyUrl, lastRead: readTime, readDuration: 0 });
          changed = true;
        }
      }
      if (changed) stats.updated_history++;
    }

    // 5. Register the CopyManga source so Mihon can resolve its name.
    if (!sourceList.some(s => String(s.sourceId) === String(DEFAULT_COPYMANGA_SOURCE_ID))) {
      sourceList.push({
        name: DEFAULT_COPYMANGA_SOURCE_NAME,
        sourceId: getSourceIdLong(DEFAULT_COPYMANGA_SOURCE_ID)
      });
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
    if (!backupObj.backupManga || backupObj.backupManga.length === 0) {
      throw new Error("没有可导出的漫画数据。");
    }
    const Backup = initProtobuf();
    const errMsg = Backup.verify(backupObj);
    if (errMsg) throw new Error("Protobuf 校验失败: " + errMsg);

    const message = Backup.create(backupObj);
    const protoBytes = Backup.encode(message).finish();
    const gzippedBytes = window.pako.gzip(protoBytes);

    const blob = new Blob([gzippedBytes], { type: 'application/octet-stream' });
    downloadBlob(blob, filename);
  }

  // --- UI Components & Styles ---
  const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
  const ICON_ALERT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>`;

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* Top slim progress bar */
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

      /* Personal center entry */
      .c2m-person-header-actions {
        margin-top: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .c2m-person-btn {
        height: 30px;
        padding: 0 14px;
        border: 1px solid rgba(255, 255, 255, 0.7);
        border-radius: 6px;
        background: #ffffff;
        color: #0d75c2;
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .c2m-person-btn:hover {
        background: #eaf5fd;
        border-color: #ffffff;
        color: #0b66ab;
      }
      .c2m-person-btn:focus-visible {
        outline: 2px solid #0d75c2;
        outline-offset: 2px;
      }

      /* Overlay */
      #c2m-modal-overlay {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(16, 24, 40, 0.52);
        z-index: 999999;
      }
      #c2m-modal-overlay[data-open="true"] {
        display: flex;
        animation: c2m-fade 160ms ease-out;
      }

      /* Dialog */
      #c2m-modal-card {
        --c2m-primary: #0d75c2;
        --c2m-primary-strong: #0b66ab;
        --c2m-text: #1f2329;
        --c2m-text-2: #5b6472;
        --c2m-text-3: #6b7280;
        --c2m-border: #e2e7ee;
        --c2m-surface-2: #f7f9fc;
        position: relative;
        width: 500px;
        max-width: 100%;
        max-height: calc(100vh - 48px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: #ffffff;
        border-radius: 14px;
        box-shadow: 0 24px 64px rgba(16, 24, 40, 0.28), 0 2px 8px rgba(16, 24, 40, 0.08);
        color: var(--c2m-text);
        font-family: inherit;
        animation: c2m-rise 180ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #c2m-modal-card *,
      #c2m-modal-card *::before,
      #c2m-modal-card *::after { box-sizing: border-box; }
      #c2m-modal-card h2,
      #c2m-modal-card h3,
      #c2m-modal-card p {
        margin: 0;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
      }
      #c2m-modal-card ::-webkit-scrollbar { width: 10px; }
      #c2m-modal-card ::-webkit-scrollbar-thumb {
        background: #dbe2ea;
        border-radius: 999px;
        border: 3px solid #ffffff;
      }
      #c2m-modal-card :focus-visible {
        outline: 2px solid var(--c2m-primary);
        outline-offset: 2px;
      }

      .c2m-modal-header {
        padding: 20px 24px 0;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .c2m-modal-title {
        font-size: 17px;
        line-height: 24px;
        font-weight: 600;
        color: var(--c2m-text);
      }
      .c2m-modal-subtitle {
        margin-top: 3px;
        font-size: 12.5px;
        line-height: 18px;
        color: var(--c2m-text-3);
      }
      .c2m-close-btn {
        flex: none;
        width: 30px;
        height: 30px;
        margin: -4px -6px 0 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: #8a93a1;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .c2m-close-btn:hover { background: #f1f4f8; color: var(--c2m-text); }
      .c2m-modal-body {
        padding: 6px 24px 22px;
        overflow-y: auto;
      }
      .c2m-view[hidden] { display: none !important; }

      /* Idle view */
      .c2m-auth {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 2px 0 4px;
        font-size: 12px;
        line-height: 18px;
        color: var(--c2m-text-2);
      }
      .c2m-auth-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #9aa3b2;
      }
      .c2m-auth[data-state="ok"] .c2m-auth-dot { background: #2f9e44; }
      .c2m-auth[data-state="warn"] .c2m-auth-dot { background: #e6a23c; }
      .c2m-auth[data-state="warn"] { color: #8a5300; }

      .c2m-alert {
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        margin: 6px 0 10px;
        border: 1px solid #f2d3a8;
        border-radius: 8px;
        background: #fdf6ec;
        color: #8a5300;
        font-size: 12.5px;
        line-height: 18px;
      }
      .c2m-alert[hidden] { display: none; }

      .c2m-section {
        padding: 16px 0;
        border-top: 1px solid #eef1f5;
      }
      .c2m-section:first-of-type { border-top: none; padding-top: 10px; }
      .c2m-section-head {
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }
      .c2m-section-icon {
        flex: none;
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        background: #eaf5fd;
        color: #0d75c2;
      }
      .c2m-section-icon svg { width: 16px; height: 16px; }
      .c2m-section-title {
        font-size: 13.5px;
        line-height: 20px;
        font-weight: 600;
        color: var(--c2m-text);
      }
      .c2m-section-desc {
        margin-top: 2px;
        font-size: 12.5px;
        line-height: 18px;
        color: var(--c2m-text-3);
      }
      .c2m-section-body { margin-top: 12px; }

      .c2m-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .c2m-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 40px;
        padding: 0 16px;
        border: 1px solid transparent;
        border-radius: 8px;
        font-family: inherit;
        font-size: 13.5px;
        font-weight: 500;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      }
      .c2m-btn:disabled { opacity: 0.55; cursor: not-allowed; }
      .c2m-btn-primary {
        background: var(--c2m-primary);
        color: #ffffff;
      }
      .c2m-btn-primary:hover:not(:disabled) { background: var(--c2m-primary-strong); }
      .c2m-btn-ghost {
        background: #ffffff;
        border-color: #d7dde6;
        color: #3c4450;
      }
      .c2m-btn-ghost:hover:not(:disabled) {
        border-color: #9ecdf0;
        background: #f4faff;
        color: #0b66ab;
      }
      .c2m-btn-block { width: 100%; }
      .c2m-actions .c2m-btn-primary { flex: 1 1 180px; }

      .c2m-field {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 12px;
      }
      .c2m-field-label {
        flex: none;
        font-size: 12.5px;
        color: var(--c2m-text-2);
      }
      .c2m-text-input {
        flex: 1;
        min-width: 0;
        height: 36px;
        padding: 0 12px;
        border: 1px solid #d7dde6;
        border-radius: 8px;
        background: #ffffff;
        color: var(--c2m-text);
        font-family: inherit;
        font-size: 13px;
        outline: none;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .c2m-text-input::placeholder { color: #6b7280; }
      .c2m-text-input:focus {
        border-color: var(--c2m-primary);
        box-shadow: 0 0 0 3px rgba(13, 117, 194, 0.16);
      }
      .c2m-hint {
        margin-top: 6px;
        font-size: 11.5px;
        line-height: 17px;
        color: var(--c2m-text-3);
      }
      .c2m-footnote {
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid #eef1f5;
        font-size: 11.5px;
        line-height: 17px;
        color: var(--c2m-text-3);
      }

      /* Running view */
      .c2m-run-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin: 16px 0 10px;
      }
      .c2m-run-title {
        font-size: 14.5px;
        font-weight: 600;
        color: var(--c2m-text);
      }
      .c2m-run-percent {
        font-size: 13px;
        font-weight: 600;
        color: var(--c2m-primary);
        font-variant-numeric: tabular-nums;
      }
      .c2m-meter-bg {
        height: 8px;
        border-radius: 999px;
        background: #edf1f6;
        overflow: hidden;
      }
      .c2m-meter-fill {
        width: 0;
        height: 100%;
        border-radius: 999px;
        background: var(--c2m-primary);
        transition: width 0.25s ease;
      }
      .c2m-run-step {
        min-height: 18px;
        margin-top: 10px;
        font-size: 12.5px;
        line-height: 18px;
        color: var(--c2m-text-2);
      }
      .c2m-log {
        display: none;
        margin-top: 14px;
        padding: 10px 12px;
        max-height: 150px;
        overflow-y: auto;
        border: 1px solid #edf1f6;
        border-radius: 10px;
        background: #f8fafc;
        color: #4b5563;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11.5px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .c2m-log[data-visible="true"] { display: block; }
      .c2m-run-note {
        margin-top: 10px;
        font-size: 11.5px;
        line-height: 17px;
        color: var(--c2m-text-3);
        text-align: right;
      }

      /* Result view */
      .c2m-result { padding-top: 18px; text-align: center; }
      .c2m-result-icon {
        width: 44px;
        height: 44px;
        margin: 0 auto 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
      }
      .c2m-result[data-kind="success"] .c2m-result-icon { background: #e9f7ef; color: #2f9e44; }
      .c2m-result[data-kind="error"] .c2m-result-icon { background: #fdecea; color: #d9480f; }
      .c2m-result-icon svg { width: 22px; height: 22px; }
      .c2m-result-title {
        font-size: 16px;
        font-weight: 600;
        color: var(--c2m-text);
      }
      .c2m-result-msg {
        margin-top: 6px;
        font-size: 12.5px;
        line-height: 18px;
        color: var(--c2m-text-2);
        word-break: break-all;
      }
      .c2m-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
        gap: 8px;
        margin-top: 14px;
        text-align: left;
      }
      .c2m-stat {
        padding: 8px 10px;
        border: 1px solid #eef1f5;
        border-radius: 8px;
        background: var(--c2m-surface-2);
      }
      .c2m-stat-label {
        font-size: 11px;
        line-height: 16px;
        color: var(--c2m-text-3);
      }
      .c2m-stat-value {
        margin-top: 2px;
        font-size: 15px;
        font-weight: 600;
        line-height: 20px;
        color: var(--c2m-text);
        font-variant-numeric: tabular-nums;
      }
      .c2m-result-hint {
        margin-top: 12px;
        font-size: 12px;
        line-height: 18px;
        color: var(--c2m-text-3);
        text-align: left;
      }
      .c2m-result-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 18px;
      }

      @keyframes c2m-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes c2m-rise {
        from { opacity: 0; transform: translateY(8px) scale(0.995); }
        to { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        #c2m-modal-overlay[data-open="true"],
        #c2m-modal-card { animation: none; }
        #c2m-modal-card *,
        #c2m-top-progress { transition: none !important; }
      }
      @media (max-width: 520px) {
        #c2m-modal-overlay { padding: 0; align-items: flex-end; }
        #c2m-modal-card {
          width: 100%;
          max-height: 90vh;
          border-radius: 14px 14px 0 0;
        }
        .c2m-modal-header { padding: 18px 18px 0; }
        .c2m-modal-body { padding: 4px 18px 18px; }
        .c2m-actions .c2m-btn-primary { flex: 1 1 100%; }
        .c2m-actions .c2m-btn-ghost { flex: 1 1 0; }
      }
    `;
    document.head.appendChild(style);
  }

  const UI = {};
  let taskBusy = false;
  let lastTask = null;
  let lastFocused = null;
  let currentView = "idle";

  function setView(view) {
    currentView = view;
    UI.idleView.hidden = view !== "idle";
    UI.runView.hidden = view !== "running";
    UI.resultView.hidden = view !== "result";
    UI.card.setAttribute("aria-busy", view === "running" ? "true" : "false");
  }

  function updateAuthStatus() {
    if (!UI.authStatus || !UI.authText) return;
    const token = detectedToken || detectTokenFromStorage();
    const loggedIn = !!document.querySelector('header a[href="/web/person"], .header-input .username');
    const ok = !!(token && token.length >= 20) || loggedIn;
    UI.authStatus.dataset.state = ok ? "ok" : "warn";
    UI.authText.textContent = token && token.length >= 20
      ? "已检测到登录状态"
      : (loggedIn ? "已登录" : "未登录，请先登录后再操作");
    if (ok) UI.authError.hidden = true;
  }

  function showAuthError(message) {
    if (!UI.authError) return;
    UI.authError.textContent = message;
    UI.authError.hidden = false;
    UI.authError.scrollIntoView({ block: "nearest" });
  }

  function ensureToken() {
    const token = detectedToken || detectTokenFromStorage();
    if (token && token.length >= 20) return token;
    updateAuthStatus();
    showAuthError("未检测到登录信息。请先在拷贝漫画登录，然后刷新页面再试。");
    return "";
  }

  function openModal() {
    if (!UI.overlay) return;
    lastFocused = document.activeElement;
    UI.overlay.dataset.open = "true";
    updateAuthStatus();
    if (currentView === "idle") UI.exportAllBtn.focus();
    else if (currentView === "result") UI.resultPrimary.focus();
    else if (currentView === "running") UI.closeBtn.focus();
  }

  function closeModal() {
    if (!UI.overlay) return;
    UI.overlay.dataset.open = "false";
    if (!taskBusy && currentView === "result") resetToIdle();
    if (lastFocused && lastFocused.isConnected) {
      try { lastFocused.focus(); } catch (_) { }
    }
    lastFocused = null;
  }

  function resetToIdle() {
    if (taskBusy) return;
    setView("idle");
    if (UI.authError) UI.authError.hidden = true;
    updateAuthStatus();
  }

  function beginTask(title) {
    setView("running");
    UI.runTitle.textContent = title;
    UI.progressFill.style.width = "0%";
    UI.progressMsg.textContent = "准备中…";
    UI.progressCount.textContent = "0%";
    UI.logBox.textContent = "";
    UI.logBox.dataset.visible = "false";
    UI.authError.hidden = true;
    UI.topProgress.style.opacity = "0";
    UI.topProgress.style.width = "0%";
  }

  function showResult(result) {
    setView("result");
    UI.resultView.dataset.kind = result.kind;
    UI.resultIcon.innerHTML = result.kind === "success" ? ICON_CHECK : ICON_ALERT;
    UI.resultTitle.textContent = result.title || "";
    UI.resultMsg.textContent = result.message || "";
    UI.resultHint.textContent = result.hint || "";
    UI.resultHint.hidden = !result.hint;

    UI.resultStats.textContent = "";
    const stats = result.stats || [];
    for (const stat of stats) {
      const cell = document.createElement("div");
      cell.className = "c2m-stat";
      const label = document.createElement("div");
      label.className = "c2m-stat-label";
      label.textContent = stat.label;
      const value = document.createElement("div");
      value.className = "c2m-stat-value";
      value.textContent = String(stat.value);
      cell.appendChild(label);
      cell.appendChild(value);
      UI.resultStats.appendChild(cell);
    }
    UI.resultStats.hidden = stats.length === 0;

    const success = result.kind === "success";
    UI.resultSecondary.textContent = success ? "继续操作" : "返回";
    UI.resultPrimary.textContent = success ? "完成" : "重试";
    UI.resultPrimary.focus();

    if (success) notifyUser(result.title || "操作完成", result.message || "");
  }

  async function runTask(task) {
    if (taskBusy) return;
    taskBusy = true;
    lastTask = task;
    beginTask(task.title);
    try {
      const output = await task.run();
      showResult(Object.assign({ kind: "success" }, task.success(output)));
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logMessage(`${task.failTitle}：${message}`);
      showResult({
        kind: "error",
        title: task.failTitle,
        message,
        hint: task.failHint || "请检查网络和登录状态后重试。",
        stats: []
      });
    } finally {
      taskBusy = false;
    }
  }

  function handleOverlayKeydown(e) {
    if (!UI.overlay || UI.overlay.dataset.open !== "true") return;
    if (e.key === "Escape") {
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = Array.from(
      UI.card.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !el.disabled && el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function createUI() {
    if (document.getElementById('c2m-modal-overlay')) return; // already injected

    injectStyles();

    // Top slim progress bar
    const topProgress = document.createElement('div');
    topProgress.id = 'c2m-top-progress';
    document.body.appendChild(topProgress);

    // Centered dialog
    const overlay = document.createElement('div');
    overlay.id = 'c2m-modal-overlay';
    overlay.dataset.open = 'false';
    overlay.innerHTML = `
      <div id="c2m-modal-card" role="dialog" aria-modal="true" aria-labelledby="c2m-modal-title">
        <div class="c2m-modal-header">
          <div>
            <h2 class="c2m-modal-title" id="c2m-modal-title">Mihon 备份工具</h2>
            <p class="c2m-modal-subtitle">书架与阅读记录 → Mihon 备份</p>
          </div>
          <button type="button" class="c2m-close-btn" id="c2m-close-modal" aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="c2m-modal-body">
          <div class="c2m-view" id="c2m-view-idle">
            <div class="c2m-auth" id="c2m-auth-status" data-state="unknown" role="status">
              <span class="c2m-auth-dot"></span>
              <span id="c2m-auth-text">正在检查登录状态…</span>
            </div>
            <div class="c2m-alert" id="c2m-auth-error" role="alert" hidden></div>

            <section class="c2m-section">
              <div class="c2m-section-head">
                <span class="c2m-section-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                </span>
                <div>
                  <h3 class="c2m-section-title">新建备份</h3>
                  <p class="c2m-section-desc">从拷贝漫画拉取书架和阅读记录，生成 .tachibk 文件</p>
                </div>
              </div>
              <div class="c2m-section-body">
                <div class="c2m-actions">
                  <button type="button" class="c2m-btn c2m-btn-primary" id="c2m-export-all">导出完整备份</button>
                  <button type="button" class="c2m-btn c2m-btn-ghost" id="c2m-export-subs">仅书架</button>
                  <button type="button" class="c2m-btn c2m-btn-ghost" id="c2m-export-hist">仅历史</button>
                </div>
                <label class="c2m-field" for="c2m-category-input">
                  <span class="c2m-field-label">分类名称</span>
                  <input class="c2m-text-input" id="c2m-category-input" type="text" value="拷贝漫画" placeholder="留空则不分类" />
                </label>
                <p class="c2m-hint">书架订阅会在 Mihon 中归入这个分类，留空则不分类。</p>
              </div>
            </section>

            <section class="c2m-section">
              <div class="c2m-section-head">
                <span class="c2m-section-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>
                </span>
                <div>
                  <h3 class="c2m-section-title">合并到已有备份</h3>
                  <p class="c2m-section-desc">保留原有内容，更新拷贝漫画的进度与已读状态，并补入新收藏</p>
                </div>
              </div>
              <div class="c2m-section-body">
                <button type="button" class="c2m-btn c2m-btn-ghost c2m-btn-block" id="c2m-merge-btn">选择 .tachibk 文件</button>
              </div>
            </section>

            <section class="c2m-section">
              <div class="c2m-section-head">
                <span class="c2m-section-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 8.5 4.5 4.5 0 0 0 7 17.5"/><path d="M12 12v6"/><path d="M9 15h6"/></svg>
                </span>
                <div>
                  <h3 class="c2m-section-title">批量订阅到拷贝</h3>
                  <p class="c2m-section-desc">读取备份中的拷贝漫画收藏，把缺少的订阅到云端书架</p>
                </div>
              </div>
              <div class="c2m-section-body">
                <button type="button" class="c2m-btn c2m-btn-ghost c2m-btn-block" id="c2m-sync-cloud-btn">选择 .tachibk 文件</button>
              </div>
            </section>

            <p class="c2m-footnote">文件只在本机生成并下载，不会上传。</p>
          </div>

          <div class="c2m-view" id="c2m-view-running" hidden>
            <div class="c2m-run-head">
              <h3 class="c2m-run-title" id="c2m-run-title">正在处理</h3>
              <span class="c2m-run-percent" id="c2m-progress-count">0%</span>
            </div>
            <div class="c2m-meter-bg">
              <div class="c2m-meter-fill" id="c2m-progress-fill"></div>
            </div>
            <p class="c2m-run-step" id="c2m-progress-msg" aria-live="polite">准备中…</p>
            <div class="c2m-log" id="c2m-log-box"></div>
            <p class="c2m-run-note">关闭面板不会中断任务。</p>
          </div>

          <div class="c2m-view c2m-result" id="c2m-view-result" data-kind="success" aria-live="polite" hidden>
            <div class="c2m-result-icon" id="c2m-result-icon"></div>
            <h3 class="c2m-result-title" id="c2m-result-title"></h3>
            <p class="c2m-result-msg" id="c2m-result-msg"></p>
            <div class="c2m-stats" id="c2m-result-stats"></div>
            <p class="c2m-result-hint" id="c2m-result-hint"></p>
            <div class="c2m-result-actions">
              <button type="button" class="c2m-btn c2m-btn-ghost" id="c2m-result-secondary">返回</button>
              <button type="button" class="c2m-btn c2m-btn-primary" id="c2m-result-primary">完成</button>
            </div>
          </div>

          <input type="file" id="c2m-file-input" accept=".tachibk" style="display:none;" />
          <input type="file" id="c2m-sync-file-input" accept=".tachibk" style="display:none;" />
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Cache refs
    UI.topProgress = topProgress;
    UI.overlay = overlay;
    UI.card = document.getElementById('c2m-modal-card');
    UI.idleView = document.getElementById('c2m-view-idle');
    UI.runView = document.getElementById('c2m-view-running');
    UI.resultView = document.getElementById('c2m-view-result');
    UI.closeBtn = document.getElementById('c2m-close-modal');
    UI.runTitle = document.getElementById('c2m-run-title');
    UI.exportAllBtn = document.getElementById('c2m-export-all');
    UI.exportSubsBtn = document.getElementById('c2m-export-subs');
    UI.exportHistBtn = document.getElementById('c2m-export-hist');
    UI.mergeBtn = document.getElementById('c2m-merge-btn');
    UI.syncCloudBtn = document.getElementById('c2m-sync-cloud-btn');
    UI.fileInput = document.getElementById('c2m-file-input');
    UI.syncFileInput = document.getElementById('c2m-sync-file-input');
    UI.categoryInput = document.getElementById('c2m-category-input');
    UI.authStatus = document.getElementById('c2m-auth-status');
    UI.authText = document.getElementById('c2m-auth-text');
    UI.authError = document.getElementById('c2m-auth-error');
    UI.progressFill = document.getElementById('c2m-progress-fill');
    UI.progressMsg = document.getElementById('c2m-progress-msg');
    UI.progressCount = document.getElementById('c2m-progress-count');
    UI.logBox = document.getElementById('c2m-log-box');
    UI.resultIcon = document.getElementById('c2m-result-icon');
    UI.resultTitle = document.getElementById('c2m-result-title');
    UI.resultMsg = document.getElementById('c2m-result-msg');
    UI.resultStats = document.getElementById('c2m-result-stats');
    UI.resultHint = document.getElementById('c2m-result-hint');
    UI.resultPrimary = document.getElementById('c2m-result-primary');
    UI.resultSecondary = document.getElementById('c2m-result-secondary');

    // Restore default category
    try {
      const savedCategory = localStorage.getItem(STORAGE_KEY_CATEGORY);
      if (savedCategory !== null) UI.categoryInput.value = savedCategory;
    } catch (_) { }
    UI.categoryInput.addEventListener('input', () => {
      try { localStorage.setItem(STORAGE_KEY_CATEGORY, UI.categoryInput.value); } catch (_) { }
    });

    // Event bindings
    document.getElementById('c2m-close-modal').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener('keydown', handleOverlayKeydown);

    UI.exportAllBtn.addEventListener('click', () => runExportPipeline(true, true));
    UI.exportSubsBtn.addEventListener('click', () => runExportPipeline(true, false));
    UI.exportHistBtn.addEventListener('click', () => runExportPipeline(false, true));

    UI.mergeBtn.addEventListener('click', () => UI.fileInput.click());
    UI.fileInput.addEventListener('change', handleMergeFileSelected);

    UI.syncCloudBtn.addEventListener('click', () => UI.syncFileInput.click());
    UI.syncFileInput.addEventListener('change', handleSyncToCloudFileSelected);

    UI.resultPrimary.addEventListener('click', () => {
      if (UI.resultView.dataset.kind === 'success') {
        closeModal();
        resetToIdle();
      } else if (lastTask) {
        runTask(lastTask);
      }
    });
    UI.resultSecondary.addEventListener('click', () => resetToIdle());

    // Register native menu commands in Tampermonkey
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand("打开导出面板", openModal);
      GM_registerMenuCommand("导出完整备份", () => { openModal(); runExportPipeline(true, true); });
      GM_registerMenuCommand("合并本地备份", () => { openModal(); UI.fileInput.click(); });
      GM_registerMenuCommand("导入备份批量订阅到拷贝", () => { openModal(); UI.syncFileInput.click(); });
    }

    injectEntryPoints();
  }

  // Entry point: personal center header card
  function injectEntryPoints() {
    injectPersonalCenterEntry();
  }

  function injectPersonalCenterEntry() {
    const avatarEl = document.querySelector('header .vavtar, .vavtar, header .el-avatar, .el-avatar--square');
    if (!avatarEl || !avatarEl.parentElement) return;
    const infoContainer = avatarEl.parentElement;
    if (infoContainer.querySelector('#c2m-person-header-actions')) return;
    document.querySelectorAll('#c2m-person-header-actions').forEach((el) => el.remove());

    const actionSection = document.createElement('section');
    actionSection.id = 'c2m-person-header-actions';
    actionSection.className = 'c2m-person-header-actions';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'c2m-person-btn';
    exportBtn.textContent = '导出到 Mihon';
    exportBtn.title = '导出书架与阅读记录至 Mihon 备份';
    exportBtn.addEventListener('click', openModal);

    actionSection.appendChild(exportBtn);
    infoContainer.appendChild(actionSection);
  }

  function logMessage(msg) {
    if (!UI.logBox) return;
    UI.logBox.dataset.visible = "true";
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
    if (UI.progressFill) UI.progressFill.style.width = `${p}%`;
    if (UI.progressMsg) UI.progressMsg.textContent = msg;
    if (UI.progressCount) UI.progressCount.textContent = `${Math.round(p)}%`;
  }

  // --- Pipeline Executions ---
  function decodeBackupFile(arrayBuffer) {
    try {
      const unzippedBytes = window.pako.ungzip(new Uint8Array(arrayBuffer));
      return initProtobuf().decode(unzippedBytes);
    } catch (_) {
      throw new Error("无法解析备份文件，请确认这是 Mihon 导出的 .tachibk 备份。");
    }
  }

  async function runExportPipeline(includeSubs, includeHist) {
    const token = ensureToken();
    if (!token) return;

    const catName = (UI.categoryInput?.value || "").trim();
    const scope = includeSubs && includeHist ? "完整备份" : (includeSubs ? "书架备份" : "历史备份");

    await runTask({
      title: `正在导出${scope}`,
      failTitle: "导出失败",
      failHint: "请检查网络连接与登录状态后重试。",
      run: async () => {
        let subs = [];
        let hist = [];

        if (includeSubs) {
          setProgress("正在获取书架数据…", 10);
          subs = await fetchAllSubscriptions(token, (cur, total) => {
            const pct = 10 + Math.round((cur / (total || 1)) * (includeHist ? 40 : 80));
            setProgress(`正在获取书架数据 (${cur}/${total})…`, pct);
          });
          logMessage(`已获取 ${subs.length} 本书架漫画`);
        }

        if (includeHist) {
          const base = includeSubs ? 50 : 10;
          setProgress("正在获取历史数据…", base);
          hist = await fetchAllReadingHistory(token, (cur, total) => {
            setProgress(`正在获取历史数据 (${cur}/${total})…`, base + Math.round((cur / (total || 1)) * (includeSubs ? 40 : 80)));
          });
          logMessage(`已获取 ${hist.length} 条历史记录`);
        }

        setProgress("正在生成备份文件…", 95);
        const backup = await convertToMihonBackup(subs, hist, catName);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
        const filename = `copymanga_backup_${timestamp}.tachibk`;
        serializeAndDownloadTachibk(backup, filename);

        setProgress("导出完成，正在下载", 100);
        logMessage(`备份已生成：${filename} (共 ${backup.backupManga.length} 本)`);
        return { filename, backup, subs: subs.length, hist: hist.length };
      },
      success: ({ filename, backup, subs, hist }) => ({
        title: "备份已生成",
        message: filename,
        stats: [
          { label: "备份漫画", value: backup.backupManga.length },
          ...(includeSubs ? [{ label: "书架", value: subs }] : []),
          ...(includeHist ? [{ label: "历史", value: hist }] : [])
        ],
        hint: "文件已开始下载。在 Mihon 中打开「设置 → 数据与存储 → 恢复备份」导入。"
      })
    });
  }

  async function handleMergeFileSelected(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const token = ensureToken();
    if (!token) return;

    const catName = (UI.categoryInput?.value || "").trim();
    const sourceName = file.name.replace(/\.tachibk$/i, '') + '_merged.tachibk';

    await runTask({
      title: "正在合并备份",
      failTitle: "合并失败",
      failHint: "请重新选择文件，确认它是 Mihon 导出的 .tachibk 备份。",
      run: async () => {
        setProgress("正在读取本地备份…", 10);
        const arrayBuffer = await file.arrayBuffer();
        const existingBackup = decodeBackupFile(arrayBuffer);
        logMessage(`已读取本地备份（原有 ${existingBackup.backupManga.length} 本漫画）`);

        setProgress("正在获取云端书架数据…", 30);
        const subs = await fetchAllSubscriptions(token, (cur, total) => {
          setProgress(`正在获取书架数据 (${cur}/${total})…`, 30 + Math.round((cur / (total || 1)) * 25));
        });

        setProgress("正在获取云端历史数据…", 60);
        const hist = await fetchAllReadingHistory(token, (cur, total) => {
          setProgress(`正在获取历史数据 (${cur}/${total})…`, 60 + Math.round((cur / (total || 1)) * 25));
        });

        setProgress("正在合并数据…", 90);
        const { mergedBackup, stats } = await mergeWithLocalBackup(existingBackup, subs, hist, catName);

        serializeAndDownloadTachibk(mergedBackup, sourceName);
        setProgress("合并完成，正在下载", 100);
        logMessage(`合并完成：${sourceName}`);
        logMessage(`  - 新增漫画: ${stats.new_manga_added} 本`);
        logMessage(`  - 更新书架: ${stats.updated_favorites} 本`);
        logMessage(`  - 标记已读: ${stats.chapters_marked_read} 话`);
        logMessage(`  - 更新历史: ${stats.updated_history} 条`);
        return stats;
      },
      success: (stats) => ({
        title: "合并完成",
        message: sourceName,
        stats: [
          { label: "新增漫画", value: stats.new_manga_added },
          { label: "更新书架", value: stats.updated_favorites },
          { label: "标记已读", value: stats.chapters_marked_read },
          { label: "更新历史", value: stats.updated_history }
        ],
        hint: "文件已开始下载。原有漫画的内容、分类与顺序保持不变。"
      })
    });
  }

  async function handleSyncToCloudFileSelected(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const token = ensureToken();
    if (!token) return;

    await runTask({
      title: "正在批量订阅",
      failTitle: "批量订阅失败",
      failHint: "请确认备份文件有效、网络与登录状态正常，然后重试。",
      run: async () => {
        setProgress("正在读取本地备份文件…", 5);
        const arrayBuffer = await file.arrayBuffer();
        const backupObj = decodeBackupFile(arrayBuffer);
        logMessage(`已读取本地备份（原有 ${backupObj.backupManga.length} 本漫画）`);

        // 1. Filter CopyManga comics (by source ID or /comic/ URL pattern)
        const targetMangaList = (backupObj.backupManga || []).filter(m => {
          const isCopySource = String(m.source) === String(DEFAULT_COPYMANGA_SOURCE_ID);
          const hasCopyUrl = m.url && m.url.includes('/comic/');
          return (isCopySource || hasCopyUrl) && (m.favorite !== false);
        });

        if (targetMangaList.length === 0) {
          logMessage("备份文件中未找到属于拷贝漫画的收藏数据。");
          return { empty: true, total: 0 };
        }

        logMessage(`找到 ${targetMangaList.length} 本拷贝漫画收藏数据`);

        // 2. Fetch current cloud subscriptions to skip already-subscribed comics
        setProgress("正在获取云端已有书架…", 15);
        let existingCloudSubs = [];
        try {
          existingCloudSubs = await fetchAllSubscriptions(token, () => {});
        } catch (err) {
          logMessage(`获取云端已有书架失败：${err.message}，将直接进行订阅尝试`);
        }

        const existingPwSet = new Set();
        for (const item of existingCloudSubs) {
          const comic = item.comic || item;
          const pw = (comic.path_word || item.comic_path_word || item.path_word || "").trim().toLowerCase();
          if (pw) existingPwSet.add(pw);
        }
        logMessage(`云端书架已有 ${existingCloudSubs.length} 本漫画`);

        // 3. Extract path_words for all target manga
        const toSubscribe = [];
        for (const m of targetMangaList) {
          const match = (m.url || "").match(/\/comic\/([^/?#]+)/);
          const pw = match ? match[1].trim() : "";
          if (!pw) continue;
          if (existingPwSet.has(pw.toLowerCase())) {
            continue;
          }
          toSubscribe.push({ pw, title: repairMojibake(m.title || pw) });
        }

        const skippedCount = targetMangaList.length - toSubscribe.length;
        if (toSubscribe.length === 0) {
          logMessage(`所有 ${targetMangaList.length} 本漫画均已在云端书架，无需重复订阅`);
          return { empty: true, total: targetMangaList.length };
        }

        logMessage(`需订阅 ${toSubscribe.length} 本新漫画（跳过已存在 ${skippedCount} 本）`);

        // 4. Batch subscribe loop with concurrency control & real-time progress
        let successCount = 0;
        let failCount = 0;
        const totalToSub = toSubscribe.length;

        for (let i = 0; i < totalToSub; i++) {
          const item = toSubscribe[i];
          const pct = 20 + Math.round(((i + 1) / totalToSub) * 75);
          setProgress(`正在订阅 (${i + 1}/${totalToSub})：${item.title}…`, pct);

          try {
            // 4a. Fetch comic detail HTML to get UUID / comic_id
            const htmlResp = await fetch(`/comic/${encodeURIComponent(item.pw)}`, {
              headers: { 'Accept': 'text/html,application/xhtml+xml' }
            });
            if (!htmlResp.ok) {
              throw new Error(`页面请求失败 (${htmlResp.status})`);
            }
            const html = await htmlResp.text();

            // Extract comic_id (36-char uuid)
            const uuidMatch = html.match(/collect\(\s*['"]([0-9a-fA-F-]{36})['"]\s*\)/) ||
                              html.match(/["']comic_id["']\s*:\s*["']([0-9a-fA-F-]{36})["']/i) ||
                              html.match(/data-id=["']([0-9a-fA-F-]{36})["']/i);
            if (!uuidMatch || !uuidMatch[1]) {
              throw new Error("未在页面中解析到 comic_id");
            }
            const comicId = uuidMatch[1];

            // 4b. Send collect POST request
            const postResp = await fetch('/api/v2/web/collect', {
              method: 'POST',
              headers: {
                'Authorization': 'Token ' + token,
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
              },
              body: `comic_id=${encodeURIComponent(comicId)}&is_collect=1`
            });

            if (!postResp.ok) {
              throw new Error(`接口报错 (${postResp.status})`);
            }
            const postData = await postResp.json();
            if (postData.code && postData.code !== 200 && postData.code !== 0) {
              throw new Error(postData.message || `业务码 ${postData.code}`);
            }

            successCount++;
            logMessage(`[${i + 1}/${totalToSub}] 成功订阅：${item.title}`);
          } catch (err) {
            failCount++;
            logMessage(`[${i + 1}/${totalToSub}] 订阅失败：${item.title}（${err.message}）`);
          }

          // Delay between requests
          await sleep(CONFIG.INTER_REQUEST_DELAY_MS || 200);
        }

        setProgress("批量订阅完成", 100);
        logMessage(`批量订阅完成：成功 ${successCount} 本, 失败 ${failCount} 本, 跳过已存在 ${skippedCount} 本`);

        if (successCount === 0) {
          throw new Error(`全部 ${failCount} 本订阅失败。`);
        }
        return { empty: false, successCount, failCount, skippedCount };
      },
      success: (out) => {
        if (out.empty) {
          return {
            title: "无需订阅",
            message: out.total > 0
              ? `全部 ${out.total} 本拷贝漫画已在云端书架。`
              : "备份中没有拷贝漫画的收藏。",
            hint: out.total > 0 ? "" : "请选择包含拷贝漫画收藏的 Mihon 备份。"
          };
        }
        return {
          title: out.failCount > 0 ? "订阅完成，部分失败" : "订阅完成",
          message: out.failCount > 0
            ? `成功订阅 ${out.successCount} 本，${out.failCount} 本未能订阅。`
            : `成功订阅 ${out.successCount} 本。`,
          stats: [
            { label: "成功订阅", value: out.successCount },
            { label: "已存在", value: out.skippedCount },
            { label: "失败", value: out.failCount }
          ],
          hint: out.failCount > 0
            ? "打开拷贝漫画书架确认结果，稍后可重新导入同一备份重试失败的条目。"
            : "打开拷贝漫画 App 或网页书架即可看到新订阅。"
        };
      }
    });
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
      injectEntryPoints();
      if (pollCount >= 15) clearInterval(pollInterval);
    }, 1000);

    // MutationObserver to watch for Vue router page changes and inject buttons dynamically
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        injectEntryPoints();
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