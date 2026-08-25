// ==UserScript==
// @name         copy2mihon - 拷贝漫画转 Mihon 备份工具
// @namespace    https://github.com/taffy/copy2mihon
// @version      0.1.0
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

  // --- Token Sniffer / Storage ---
  let detectedToken = localStorage.getItem(STORAGE_KEY_TOKEN) || "";

  function cleanToken(raw) {
    if (!raw) return "";
    let t = raw.trim().replace(/^['"]+|['"]+$/g, '');
    if (t.toLowerCase().startsWith('token ')) t = t.slice(6).trim();
    if (t.toLowerCase().startsWith('bearer ')) t = t.slice(7).trim();
    return t;
  }

  function detectTokenFromStorage() {
    if (detectedToken) return detectedToken;
    const candidates = ['token', 'authorization', 'auth', 'user_token', 'member_token'];
    for (const k of candidates) {
      const val = localStorage.getItem(k) || sessionStorage.getItem(k);
      if (val) {
        const cleaned = cleanToken(val);
        if (cleaned.length >= 20) {
          detectedToken = cleaned;
          return detectedToken;
        }
      }
    }
    // Check vuex in localStorage
    try {
      const vuexStr = localStorage.getItem('vuex');
      if (vuexStr) {
        const vObj = JSON.parse(vuexStr);
        if (vObj?.user?.token) return cleanToken(vObj.user.token);
        if (vObj?.auth?.token) return cleanToken(vObj.auth.token);
      }
    } catch (_) {}
    return "";
  }

  // Hook XHR & Fetch to catch Token live
  function installNetworkHooks() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function () {
      this._headers = {};
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      if (header && header.toLowerCase() === 'authorization') {
        const tok = cleanToken(value);
        if (tok && tok.length >= 20 && tok !== detectedToken) {
          detectedToken = tok;
          updateTokenDisplay();
        }
      }
      return origSetHeader.apply(this, arguments);
    };

    if (window.fetch) {
      const origFetch = window.fetch;
      window.fetch = function (resource, init) {
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
    }
  }

  // --- Cleaners and Helpers ---
  async function sha1Hex(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function stableFallbackKey(comicItem) {
    const title = comicItem?.name || comicItem?.title || JSON.stringify(comicItem);
    const hex = await sha1Hex(title);
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

  // --- API Client ---
  async function fetchWithRetry(url, token, maxRetries = 3) {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Authorization': `Token ${token}`,
      'Platform': '2',
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, { headers, method: 'GET' });
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Token 无效或无权限 (${res.status})，请检查 Token。`);
        }
        if (res.status === 429) {
          await new Promise(r => setTimeout(r, attempt * 2000));
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
        if (attempt === maxRetries || err.message.includes('Token 无效')) {
          throw err;
        }
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  }

  async function fetchAllSubscriptions(token, onProgress) {
    const results = [];
    let offset = 0;
    const limit = 30;
    const baseUrl = window.location.origin;

    while (true) {
      const url = `${baseUrl}/api/v3/member/collect/comics?limit=${limit}&offset=${offset}&free_type=1&ordering=-datetime_modifier`;
      const resp = await fetchWithRetry(url, token);
      const list = resp?.results?.list || [];
      const total = resp?.results?.total || list.length;

      if (list.length === 0) break;
      results.push(...list);
      if (onProgress) onProgress(results.length, total);

      if (results.length >= total || list.length < limit) break;
      offset += limit;
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
  }

  async function fetchAllReadingHistory(token, onProgress) {
    const results = [];
    let offset = 0;
    const limit = 30;
    const baseUrl = window.location.origin;

    while (true) {
      const url = `${baseUrl}/api/kb/web/browses?limit=${limit}&offset=${offset}`;
      const resp = await fetchWithRetry(url, token);
      const list = resp?.results?.list || [];
      const total = resp?.results?.total || list.length;

      if (list.length === 0) break;
      results.push(...list);
      if (onProgress) onProgress(results.length, total);

      if (results.length >= total || list.length < limit) break;
      offset += limit;
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
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

      const title = repairMojibake(comic.name || comic.title || "");
      const author = (comic.author || []).map(a => repairMojibake(a.name || a)).join(", ");
      const cover = comic.cover || "";
      const status = (comic.status === 2 || comic.status === "2" || (comic.status_str || "").includes("完结")) ? 2 : 1;
      const dateAdded = parseDateTimeToMs(item.datetime_created || item.last_updatetime);

      mangaByUrl.set(url, {
        source: getSourceIdLong(DEFAULT_COPYMANGA_SOURCE_ID),
        url: url,
        title: title,
        author: author,
        artist: author,
        status: status,
        thumbnailUrl: cover,
        dateAdded: dateAdded,
        favorite: true,
        initialized: true,
        chapterFlags: 513,
        viewer_flags: 0,
        categories: [...catOrders],
        chapters: [],
        history: [],
        memo: [new TextEncoder().encode("{}")]
      });
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
        const title = repairMojibake(comic.name || comic.title || "Unknown Manga");
        const author = (comic.author || []).map(a => repairMojibake(a.name || a)).join(", ");
        const cover = comic.cover || "";
        manga = {
          source: getSourceIdLong(DEFAULT_COPYMANGA_SOURCE_ID),
          url: url,
          title: title,
          author: author,
          artist: author,
          status: 1,
          thumbnailUrl: cover,
          dateAdded: readTime,
          favorite: false,
          initialized: true,
          chapterFlags: 513,
          viewer_flags: 0,
          categories: [],
          chapters: [],
          history: [],
          memo: [new TextEncoder().encode("{}")]
        };
        mangaByUrl.set(url, manga);
      }

      if (chUuid) {
        let chNum = 0.0;
        const numMatch = chName.match(/(\d+(\.\d+)?)/);
        if (numMatch) chNum = parseFloat(numMatch[1]);

        manga.chapters = [{
          url: chUrl,
          name: chName,
          read: true,
          lastPageRead: 1,
          dateFetch: readTime,
          dateUpload: readTime,
          chapterNumber: chNum,
          sourceOrder: 0,
          memo: [new TextEncoder().encode("{}")]
        }];

        manga.history = [{
          url: chUrl,
          lastRead: readTime,
          readDuration: 0
        }];
      }
    }

    const categories = [];
    if (catOrders.length > 0) {
      categories.push({
        name: categoryName,
        id: 1,
        order: 0,
        flags: 0
      });
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
        const title = repairMojibake(comic.name || comic.title || "Unknown");
        const author = (comic.author || []).map(a => repairMojibake(a.name || a)).join(", ");
        const cover = comic.cover || "";
        const status = (comic.status === 2 || (comic.status_str || "").includes("完结")) ? 2 : 1;
        const dateAdded = parseDateTimeToMs(item.datetime_created || item.last_updatetime);
        const url = `/comic/${pw}`;

        const newManga = {
          source: getSourceIdLong(DEFAULT_COPYMANGA_SOURCE_ID),
          url: url,
          title: title,
          author: author,
          artist: author,
          status: status,
          thumbnailUrl: cover,
          dateAdded: dateAdded,
          favorite: true,
          initialized: true,
          chapterFlags: 513,
          viewer_flags: 0,
          categories: targetCatOrder !== null ? [targetCatOrder] : [],
          chapters: [],
          history: [],
          memo: [new TextEncoder().encode("{}")]
        };
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
          let matchedCh = null;
          if (chUuid) {
            matchedCh = m.chapters.find(ch => ch.url.includes(chUuid));
          }
          if (!matchedCh && chName) {
            const numMatch = chName.match(/(\d+(\.\d+)?)/);
            if (numMatch) {
              const val = parseFloat(numMatch[1]);
              matchedCh = m.chapters.find(ch => Math.abs(ch.chapterNumber - val) < 0.01);
            }
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
          let chNum = 0.0;
          const numMatch = chName.match(/(\d+(\.\d+)?)/);
          if (numMatch) chNum = parseFloat(numMatch[1]);
          m.chapters = [{
            url: chUrl,
            name: chName,
            read: true,
            lastPageRead: 1,
            dateFetch: readTime,
            dateUpload: readTime,
            chapterNumber: chNum,
            sourceOrder: 0,
            memo: [new TextEncoder().encode("{}")]
          }];
          m.history = [{ url: chUrl, lastRead: readTime, readDuration: 0 }];
        }
      } else {
        if (chUuid) {
          const title = repairMojibake(comic.name || comic.title || "Unknown");
          const cover = comic.cover || "";
          let chNum = 0.0;
          const numMatch = chName.match(/(\d+(\.\d+)?)/);
          if (numMatch) chNum = parseFloat(numMatch[1]);

          const newManga = {
            source: getSourceIdLong(DEFAULT_COPYMANGA_SOURCE_ID),
            url: `/comic/${pw}`,
            title: title,
            status: 1,
            thumbnailUrl: cover,
            dateAdded: readTime,
            favorite: false,
            initialized: true,
            chapterFlags: 513,
            categories: [],
            chapters: [{
              url: chUrl,
              name: chName,
              read: true,
              lastPageRead: 1,
              dateFetch: readTime,
              dateUpload: readTime,
              chapterNumber: chNum,
              sourceOrder: 0,
              memo: [new TextEncoder().encode("{}")]
            }],
            history: [{ url: chUrl, lastRead: readTime, readDuration: 0 }],
            memo: [new TextEncoder().encode("{}")]
          };
          existingBackup.backupManga.push(newManga);
          mangaByPathWord.set(pwLower, newManga);
          stats.new_manga_added++;
          stats.updated_history++;
        }
      }
    }

    return { mergedBackup: existingBackup, stats };
  }

  // --- Download Helper ---
  function downloadBlob(blob, filename) {
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

  // --- UI Components & Styles ---
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #c2m-fab {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 24px;
        box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
        cursor: pointer;
        z-index: 999999;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        user-select: none;
      }
      #c2m-fab:hover {
        transform: scale(1.08) translateY(-2px);
        box-shadow: 0 6px 20px rgba(99, 102, 241, 0.55);
      }
      #c2m-panel {
        position: fixed;
        bottom: 88px;
        right: 24px;
        width: 360px;
        background: rgba(255, 255, 255, 0.96);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(229, 231, 235, 0.8);
        border-radius: 16px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.12);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #1f2937;
        overflow: hidden;
        display: none;
        animation: c2m-slide-up 0.25s ease-out;
      }
      @keyframes c2m-slide-up {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .c2m-header {
        background: linear-gradient(135deg, #4f46e5, #7c3aed);
        color: white;
        padding: 14px 18px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .c2m-title {
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.3px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .c2m-body {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .c2m-token-badge {
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 8px;
        background: #f3f4f6;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .c2m-token-ok { color: #059669; font-weight: 600; }
      .c2m-token-no { color: #dc2626; font-weight: 600; }
      .c2m-btn {
        width: 100%;
        padding: 10px;
        border-radius: 10px;
        font-size: 13.5px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .c2m-btn-primary {
        background: #4f46e5;
        color: white;
      }
      .c2m-btn-primary:hover { background: #4338ca; }
      .c2m-btn-secondary {
        background: #f3f4f6;
        color: #374151;
      }
      .c2m-btn-secondary:hover { background: #e5e7eb; }
      .c2m-btn-success {
        background: #10b981;
        color: white;
      }
      .c2m-btn-success:hover { background: #059669; }
      .c2m-progress-container {
        display: none;
        flex-direction: column;
        gap: 6px;
        margin-top: 4px;
      }
      .c2m-progress-bar-bg {
        height: 6px;
        background: #e5e7eb;
        border-radius: 999px;
        overflow: hidden;
      }
      .c2m-progress-bar-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #4f46e5, #10b981);
        transition: width 0.2s ease;
      }
      .c2m-progress-text {
        font-size: 11.5px;
        color: #6b7280;
        display: flex;
        justify-content: space-between;
      }
      .c2m-log {
        font-size: 11.5px;
        color: #4b5563;
        background: #f9fafb;
        border: 1px solid #f3f4f6;
        border-radius: 8px;
        padding: 8px;
        max-height: 80px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        display: none;
      }
      .c2m-settings-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12.5px;
        color: #4b5563;
      }
      .c2m-input {
        padding: 4px 8px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        font-size: 12px;
        width: 110px;
      }
    `;
    document.head.appendChild(style);
  }

  function createUI() {
    injectStyles();

    // FAB Button
    const fab = document.createElement('div');
    fab.id = 'c2m-fab';
    fab.innerHTML = '📖';
    fab.title = '打开 copy2mihon 导出面板';
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'c2m-panel';
    panel.innerHTML = `
      <div class="c2m-header">
        <div class="c2m-title">📖 copy2mihon 备份助手</div>
        <div style="cursor:pointer;font-size:16px;" id="c2m-close">✕</div>
      </div>
      <div class="c2m-body">
        <div class="c2m-token-badge">
          <span id="c2m-token-status">检测中...</span>
          <a href="javascript:void(0)" id="c2m-set-token-btn" style="color:#4f46e5;font-size:11.5px;text-decoration:none;">手动设置</a>
        </div>

        <button class="c2m-btn c2m-btn-primary" id="c2m-export-all">
          📥 导出全部 (书架 + 历史)
        </button>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <button class="c2m-btn c2m-btn-secondary" id="c2m-export-subs">📚 仅书架</button>
          <button class="c2m-btn c2m-btn-secondary" id="c2m-export-hist">🕒 仅历史</button>
        </div>

        <button class="c2m-btn c2m-btn-success" id="c2m-merge-btn">
          🔄 合并至本地 .tachibk 备份
        </button>
        <input type="file" id="c2m-file-input" accept=".tachibk" style="display:none;" />

        <div class="c2m-settings-row">
          <span>书架分类名称:</span>
          <input type="text" class="c2m-input" id="c2m-category-input" value="拷贝漫画" />
        </div>

        <div class="c2m-progress-container" id="c2m-progress-box">
          <div class="c2m-progress-bar-bg">
            <div class="c2m-progress-bar-fill" id="c2m-progress-fill"></div>
          </div>
          <div class="c2m-progress-text">
            <span id="c2m-progress-msg">准备拉取...</span>
            <span id="c2m-progress-count">0%</span>
          </div>
        </div>

        <div class="c2m-log" id="c2m-log-box"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Event Bindings
    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
      updateTokenDisplay();
    });

    document.getElementById('c2m-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });

    document.getElementById('c2m-set-token-btn').addEventListener('click', () => {
      const current = detectedToken || "";
      const input = prompt("请输入拷贝漫画 Token (或 Authorization 头):", current);
      if (input !== null) {
        detectedToken = cleanToken(input);
        localStorage.setItem(STORAGE_KEY_TOKEN, detectedToken);
        updateTokenDisplay();
      }
    });

    document.getElementById('c2m-export-all').addEventListener('click', () => runExportPipeline(true, true));
    document.getElementById('c2m-export-subs').addEventListener('click', () => runExportPipeline(true, false));
    document.getElementById('c2m-export-hist').addEventListener('click', () => runExportPipeline(false, true));

    const fileInput = document.getElementById('c2m-file-input');
    document.getElementById('c2m-merge-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleMergeFileSelected);

    updateTokenDisplay();
  }

  function updateTokenDisplay() {
    const statusEl = document.getElementById('c2m-token-status');
    if (!statusEl) return;
    const token = detectedToken || detectTokenFromStorage();
    if (token) {
      statusEl.innerHTML = `<span class="c2m-token-ok">● Token: ${token.slice(0, 6)}...${token.slice(-4)}</span>`;
    } else {
      statusEl.innerHTML = `<span class="c2m-token-no">● 未检测到 Token</span>`;
    }
  }

  function logMessage(msg) {
    const logBox = document.getElementById('c2m-log-box');
    if (logBox) {
      logBox.style.display = 'block';
      logBox.textContent += msg + '\n';
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function setProgress(msg, percent = 0) {
    const box = document.getElementById('c2m-progress-box');
    const fill = document.getElementById('c2m-progress-fill');
    const msgEl = document.getElementById('c2m-progress-msg');
    const countEl = document.getElementById('c2m-progress-count');
    if (box) box.style.display = 'flex';
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (msgEl) msgEl.textContent = msg;
    if (countEl) countEl.textContent = `${Math.round(percent)}%`;
  }

  // --- Pipeline Executions ---
  async function runExportPipeline(includeSubs, includeHist) {
    const token = detectedToken || detectTokenFromStorage();
    if (!token) {
      alert("请先登录拷贝漫画，或点击【手动设置】输入您的 Token！");
      return;
    }

    const catName = document.getElementById('c2m-category-input')?.value || "拷贝漫画";
    const logBox = document.getElementById('c2m-log-box');
    if (logBox) { logBox.textContent = ''; logBox.style.display = 'none'; }

    try {
      let subs = [];
      let hist = [];

      if (includeSubs) {
        setProgress("正在获取书架订阅...", 10);
        subs = await fetchAllSubscriptions(token, (cur, total) => {
          const pct = Math.round((cur / (total || 1)) * 40) + 10;
          setProgress(`拉取书架中 (${cur}/${total})...`, pct);
        });
        logMessage(`✓ 已拉取 ${subs.length} 本书架漫画`);
      }

      if (includeHist) {
        setProgress("正在获取阅读历史...", 50);
        hist = await fetchAllReadingHistory(token, (cur, total) => {
          const pct = Math.round((cur / (total || 1)) * 40) + 50;
          setProgress(`拉取历史中 (${cur}/${total})...`, pct);
        });
        logMessage(`✓ 已拉取 ${hist.length} 条阅读历史`);
      }

      setProgress("正在转换与生成 Mihon 备份...", 95);
      const backup = await convertToMihonBackup(subs, hist, catName);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const filename = `copymanga_backup_${timestamp}.tachibk`;
      serializeAndDownloadTachibk(backup, filename);

      setProgress("导出完成！已开始下载", 100);
      logMessage(`✓ 备份已生成: ${filename} (总计 ${backup.backupManga.length} 本漫画)`);
    } catch (err) {
      alert("导出失败: " + err.message);
      logMessage("✕ 错误: " + err.message);
      setProgress("导出出错", 0);
    }
  }

  async function handleMergeFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    const token = detectedToken || detectTokenFromStorage();
    if (!token) {
      alert("请先登录拷贝漫画，或点击【手动设置】输入您的 Token！");
      return;
    }

    const catName = document.getElementById('c2m-category-input')?.value || "拷贝漫画";
    const logBox = document.getElementById('c2m-log-box');
    if (logBox) { logBox.textContent = ''; logBox.style.display = 'none'; }

    try {
      setProgress("正在读取本地 .tachibk 文件...", 10);
      const arrayBuffer = await file.arrayBuffer();
      const unzippedBytes = window.pako.ungzip(new Uint8Array(arrayBuffer));

      const Backup = initProtobuf();
      const existingBackup = Backup.decode(unzippedBytes);
      logMessage(`✓ 本地备份解析成功 (原有 ${existingBackup.backupManga.length} 本漫画)`);

      setProgress("正在从云端拉取最新书架订阅...", 30);
      const subs = await fetchAllSubscriptions(token, (cur, total) => {
        setProgress(`拉取书架 (${cur}/${total})...`, 30 + Math.round((cur / (total || 1)) * 25));
      });

      setProgress("正在从云端拉取最新阅读历史...", 60);
      const hist = await fetchAllReadingHistory(token, (cur, total) => {
        setProgress(`拉取历史 (${cur}/${total})...`, 60 + Math.round((cur / (total || 1)) * 25));
      });

      setProgress("正在增量合并至本地备份...", 90);
      const { mergedBackup, stats } = await mergeWithLocalBackup(existingBackup, subs, hist, catName);

      const outName = file.name.replace(/\.tachibk$/i, '') + '_merged.tachibk';
      serializeAndDownloadTachibk(mergedBackup, outName);

      setProgress("合并完成！已触发下载", 100);
      logMessage(`✓ 合并完成并保存: ${outName}`);
      logMessage(`  - 新增漫画: ${stats.new_manga_added} 本`);
      logMessage(`  - 更新书架: ${stats.updated_favorites} 本`);
      logMessage(`  - 标记已读: ${stats.chapters_marked_read} 话`);
      logMessage(`  - 更新历史: ${stats.updated_history} 条`);
    } catch (err) {
      alert("合并失败: " + err.message);
      logMessage("✕ 错误: " + err.message);
      setProgress("合并出错", 0);
    } finally {
      e.target.value = '';
    }
  }

  // --- Initialize ---
  installNetworkHooks();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI);
  } else {
    createUI();
  }

})();
