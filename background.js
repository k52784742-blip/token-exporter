// 后台服务：网络抓取、cookie 读取、授权换 token、续期、存储。
// 注意 MV3 的 service worker 空闲 30 秒左右就会被杀掉，所以任何要留的东西都得写 storage，
// 不能靠模块级变量撑着。

import { PRESETS, DEVICE_PATH, LOGIN_PENDING, detectPlatform, platformById } from './platforms.js';
import {
  looksJwt, parseJwt, normalizeEpoch, hashStr,
  buildDeviceRow, buildGenericRow, normalizeImport, rowKey,
  toDeviceExport, toGenericExport,
} from './utils.js';
import {
  hostOf, listSessions, snapshotSession, restoreSession, resumePending,
  removeSession, clearSessions, exportSessions, importSessions,
  autoSnapshot, maybeAutoRestore,
} from './session.js';

const K = {
  pool: 'accounts_v1',
  custom: 'custom_platforms_v1',
  captured: 'captured_v1',
  autoRefreshAt: 'auto_refresh_at',
  settings: 'settings_v1',
  siteRules: 'site_rules_v1',
};

async function getPool() {
  const { [K.pool]: raw } = await chrome.storage.local.get(K.pool);
  return Array.isArray(raw) ? raw.filter((r) => r && r.access_token) : [];
}

async function setPool(list) {
  await chrome.storage.local.set({ [K.pool]: list });
  updateBadge().catch(() => {});
}

async function getCustom() {
  const { [K.custom]: raw } = await chrome.storage.local.get(K.custom);
  return Array.isArray(raw) ? raw.filter((p) => p && p.id && p.mode) : [];
}

async function getSettings() {
  const { [K.settings]: s } = await chrome.storage.local.get(K.settings);
  return {
    showFloatingPanel: false, autoRefresh: true, sortMode: 'urgency',
    lastPlatform: '', exportFormat: 'auto', filterStatus: 'all',
    captureAll: true, allowHosts: [], autoSnapshot: true, autoRestore: true, ...(s || {}),
  };
}

// 站点规则：{ 'example.com': { hook: false } }
// 有些站点对钩子特别敏感，允许单独关掉
async function getSiteRules() {
  const { [K.siteRules]: raw } = await chrome.storage.local.get(K.siteRules);
  return (raw && typeof raw === 'object') ? raw : {};
}

async function getCaptured() {
  const { [K.captured]: raw } = await chrome.storage.local.get(K.captured);
  return Array.isArray(raw) ? raw : [];
}

async function setCaptured(list) {
  const trimmed = list.slice(-120);
  await chrome.storage.local.set({ [K.captured]: trimmed });
  return trimmed;
}

async function upsert(row) {
  const list = await getPool();
  const key = rowKey(row);
  const i = list.findIndex((r) => rowKey(r) === key);
  if (i >= 0) list[i] = row;
  else list.push(row);
  await setPool(list);
  return list;
}

async function removeRow(key) {
  const list = (await getPool()).filter((r) => rowKey(r) !== key);
  await setPool(list);
  return list;
}

// 抓到的 token 先落盘。同一条 token 只留一份。
// 这里的过滤要严一点：早先只卡长度 20，导致用户名、UUID、base64 图片片段
// 全被当成 token 收进池子，体检一看全是失效。
function plausibleToken(t) {
  if (!t || typeof t !== 'string') return false;
  const s = t.trim();
  if (s.length < 16 || s.length > 20000) return false;

  // 带空格 / 换行的不是 token
  if (/\s/.test(s)) return false;

  // 明显的非 token：URL、JSON、纯数字、纯十六进制哈希（长度不对）、
  // 常见单词、邮箱
  if (/^https?:\/\//i.test(s)) return false;
  if (/^[{[]/.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  if (/^[0-9a-f]{32}$/i.test(s)) return false;          // MD5
  if (/^[0-9a-f]{40}$/i.test(s)) return false;          // SHA1
  if (/^[0-9a-f]{64}$/i.test(s)) return false;          // SHA256
  if (/^[0-9a-f-]{36}$/i.test(s)) return false;         // UUID
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return false;  // 邮箱
  if (/^(true|false|null|undefined|nan)$/i.test(s)) return false;

  // JWT：三段式，第一段能 base64 解出 {"alg":
  const parts = s.split('.');
  if (parts.length === 3) {
    try {
      const head = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'));
      if (head.includes('alg')) return true;
    } catch (e) {}
    // 解不出来也允许，有些 token 不是标准 JWT
    if (/^[A-Za-z0-9_-]{10,}$/.test(parts[0]) && /^[A-Za-z0-9_-]{10,}$/.test(parts[1])) return true;
  }

  // 非 JWT：要求足够长且字符集像 token（base64url / hex / 带连字符）
  if (s.length < 20) return false;
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(s)) return false;

  // 全小写字母+数字、没有混合大小写、没有符号 —— 很可能是 slug 或 uuid
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /\d/.test(s);
  const hasSymbol = /[_\-+/=.]/.test(s);
  if (!hasUpper && !hasSymbol) return false;   // 纯小写+数字，多半不是
  if (!hasDigit && !hasSymbol) return false;   // 纯字母，多半不是

  return true;
}

async function remember(token, kind, source, host) {
  if (!plausibleToken(token)) return false;
  const t = token.trim();

  const key = hashStr(t);
  const list = await getCaptured();
  if (list.some((c) => c.key === key)) return false;

  list.push({
    key,
    token: t,
    kind: String(kind || 'body'),
    source: String(source || ''),
    host: String(host || ''),
    at: Date.now(),
  });
  await setCaptured(list);
  return true;
}

// webRequest 只能看到请求头，响应体要靠 page-hook 那边 postMessage 过来
// 角标：有快要过期的就显示数字，一眼能看到
async function updateBadge() {
  try {
    const pool = await getPool();
    const now = Date.now();
    const urgent = pool.filter((r) => {
      if (!r.expiresAt) return false;
      const left = r.expiresAt - now;
      return left > 0 && left < 24 * 3600 * 1000;
    }).length;
    const expired = pool.filter((r) => r.expiresAt && r.expiresAt <= now).length;

    if (urgent > 0) {
      await chrome.action.setBadgeText({ text: String(urgent) });
      await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    } else if (expired > 0) {
      await chrome.action.setBadgeText({ text: String(expired) });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {}
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    try {
      for (const h of details.requestHeaders || []) {
        const name = String(h.name || '').toLowerCase();
        if (name !== 'authorization' && !name.includes('token') && name !== 'x-api-key') continue;
        const v = String(h.value || '');
        const m = v.match(/^Bearer\s+(.+)$/i);
        let host = '';
        try { host = new URL(details.url).hostname; } catch (e) {}
        remember(m ? m[1] : v, 'header', details.url, host).catch(() => {});
      }
    } catch (e) {}
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// 页面 JS 读不到 HttpOnly，这里补上
async function scanCookies(host) {
  const found = [];
  try {
    const query = host ? { domain: host } : {};
    let list = await chrome.cookies.getAll(query);
    if (!list.length) list = await chrome.cookies.getAll({});

    for (const c of list) {
      if (!c || !c.value) continue;
      if (host && c.domain && !c.domain.includes(host) && !host.includes(c.domain.replace(/^\./, ''))) {
        continue;
      }
      if (looksJwt(c.value)) {
        await remember(c.value, 'cookie:' + c.name, c.domain, host);
        found.push({ name: c.name, domain: c.domain, httpOnly: c.httpOnly });
      }
    }
  } catch (e) {}
  return found;
}

const COMMON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
};

async function jsonFetch(url, options = {}) {
  const { method = 'GET', headers = {}, body = null } = options;
  const res = await fetch(url, { method, headers, body, credentials: 'include' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error('响应不是 JSON（HTTP ' + res.status + '）');
  }
  return { status: res.status, json };
}

async function deviceStart(platform) {
  const { status, json } = await jsonFetch(
    platform.origin + DEVICE_PATH.state + '?platform=CLI',
    { method: 'POST', headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' }, body: '{}' }
  );
  const data = json?.data || {};
  if (!data.state || !data.authUrl) {
    throw new Error(json?.msg || ('auth/state 返回异常（HTTP ' + status + '）'));
  }
  return { state: data.state, authUrl: data.authUrl };
}

async function devicePoll(platform, state) {
  const { status, json } = await jsonFetch(
    platform.origin + DEVICE_PATH.token + '?state=' + encodeURIComponent(state),
    { headers: COMMON_HEADERS }
  );
  if (!json) return { status: 'error', message: 'HTTP ' + status };
  if (json.code === LOGIN_PENDING) return { status: 'pending' };
  if (json.code !== 0) return { status: 'error', message: `code=${json.code} ${json.msg || ''}`.trim() };
  const data = json.data || {};
  if (!data.accessToken) return { status: 'pending' };
  return { status: 'ok', data };
}

async function deviceProfile(platform, token) {
  try {
    const { json } = await jsonFetch(platform.origin + DEVICE_PATH.account, {
      headers: { ...COMMON_HEADERS, Authorization: 'Bearer ' + token },
    });
    return json?.data || {};
  } catch (e) { return {}; }
}

// 上游每次续期都会换一个新的 refresh_token，旧的立刻作废。
// 所以这里一拿到结果就写盘，中间不能插任何可能失败的操作。
async function deviceRefresh(row) {
  const platform = platformById(row.platform, await getCustom());
  if (!platform || platform.mode !== 'device') {
    return { ok: false, reason: '该平台不支持续期' };
  }
  if (!row.refresh_token) return { ok: false, reason: '没有 refresh_token，只能重新授权' };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Refresh-Token': row.refresh_token,
    'X-Auth-Refresh-Source': platform.refreshSource,
    'X-User-Id': row.uid || '',
    'X-Domain': row.domain || platform.domain,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept-Language': platform.acceptLanguage,
  };

  let res;
  try {
    res = await jsonFetch(platform.origin + DEVICE_PATH.refresh, {
      method: 'POST', headers, body: '{}',
    });
  } catch (e) {
    return { ok: false, reason: e.message || '请求失败' };
  }

  const payload = res.json;
  if (!payload) return { ok: false, reason: 'HTTP ' + res.status + '（无 JSON）' };

  let data = payload.data || {};
  if (data.data && typeof data.data === 'object') data = data.data;

  if (!data.accessToken) return { ok: false, reason: payload.msg || ('HTTP ' + res.status) };

  const next = buildDeviceRow(
    data.accessToken,
    data.refreshToken || row.refresh_token,
    { uid: row.uid, nickname: row.nickname, uin: row.auth_raw?.account?.uin || '' },
    platform,
    data
  );
  next.platform = row.platform;
  next.lastRefreshAt = Date.now();
  await upsert(next);
  return { ok: true, row: next };
}

function needsRefresh(row, now = Date.now()) {
  if (!row.refresh_token) return false;
  if ((row.refreshExpiresAt || 0) - now <= 0) return false;
  return (row.expiresAt || 0) - now < 24 * 3600 * 1000;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'get-state': {
          const custom = await getCustom();
          sendResponse({
            ok: true,
            pool: await getPool(),
            captured: await getCaptured(),
            platforms: PRESETS.concat(custom),
            settings: await getSettings(),
          });
          break;
        }

        case 'capture': {
          const host = msg.host || (sender.tab ? safeHost(sender.tab.url) : '');
          const added = await remember(msg.token, msg.kind, msg.source, host);
          sendResponse({ ok: true, added });
          break;
        }

        case 'scan': {
          const host = msg.host || (sender.tab ? safeHost(sender.tab.url) : '');
          const cookies = await scanCookies(host);
          sendResponse({ ok: true, captured: await getCaptured(), cookies });
          break;
        }

        case 'authorize': {
          const platform = platformById(msg.platformId, await getCustom());
          if (!platform) return sendResponse({ ok: false, error: '未知平台' });
          const { state, authUrl } = await deviceStart(platform);
          sendResponse({ ok: true, state, authUrl });
          break;
        }

        case 'poll-now': {
          const platform = platformById(msg.platformId, await getCustom());
          if (!platform) return sendResponse({ ok: false, error: '未知平台' });
          const r = await devicePoll(platform, msg.state);
          if (r.status === 'ok') {
            const profile = await deviceProfile(platform, r.data.accessToken);
            const row = buildDeviceRow(
              r.data.accessToken, r.data.refreshToken || '', profile, platform, r.data
            );
            if (!row.uid) return sendResponse({ ok: true, status: 'error', message: 'token 里没有 uid' });
            await upsert(row);
            return sendResponse({ ok: true, status: 'ok', row });
          }
          sendResponse({ ok: true, status: r.status, message: r.message });
          break;
        }

        case 'add-captured': {
          const list = await getCaptured();
          const c = list.find((x) => x.key === msg.key);
          if (!c) return sendResponse({ ok: false, error: '已失效，请重新扫描' });
          const host = c.host || msg.host || '';
          const row = buildGenericRow(c.token, '', {
            platform: 'site:' + host,
            domain: host,
            source: c.source,
          });
          await upsert(row);
          sendResponse({ ok: true });
          break;
        }

        case 'add-captured-many': {
          const list = await getCaptured();
          const want = Array.isArray(msg.keys) ? new Set(msg.keys) : null;
          const picked = want ? list.filter((c) => want.has(c.key)) : list;
          let ok = 0;
          for (const c of picked) {
            const host = c.host || '';
            const row = buildGenericRow(c.token, '', {
              platform: 'site:' + host, domain: host, source: c.source,
            });
            await upsert(row);
            ok++;
          }
          sendResponse({ ok: true, added: ok });
          break;
        }

        case 'preview-import': {
          // 导入前先看会新增什么、覆盖什么
          const pool = await getPool();
          const known = new Set(pool.map(rowKey));
          const items = Array.isArray(msg.rows) ? msg.rows : [];
          const custom = await getCustom();
          const platform = msg.platformId ? platformById(msg.platformId, custom) : null;

          const added = [];
          const updated = [];
          const invalid = [];
          const seen = new Set();

          for (const item of items) {
            try {
              const row = normalizeImport(item, platform);
              const k = rowKey(row);
              if (seen.has(k)) { invalid.push({ name: row.nickname || row.uid, reason: '文件内重复' }); continue; }
              seen.add(k);
              const label = row.nickname || String(row.uid || '').slice(0, 10) || '(未命名)';
              if (known.has(k)) updated.push(label); else added.push(label);
            } catch (e) {
              invalid.push({ name: String(item?.nickname || item?.uid || '?').slice(0, 20), reason: e.message });
            }
          }
          sendResponse({ ok: true, added, updated, invalid, total: items.length });
          break;
        }

        case 'add-token': {
          const platform = msg.platformId ? platformById(msg.platformId, await getCustom()) : null;
          const row = normalizeImport(msg.row, platform);
          await upsert(row);
          sendResponse({ ok: true, row });
          break;
        }

        case 'remove': {
          sendResponse({ ok: true, pool: await removeRow(msg.key) });
          break;
        }

        case 'remove-many': {
          const keys = new Set(Array.isArray(msg.keys) ? msg.keys : []);
          const list = (await getPool()).filter((r) => !keys.has(rowKey(r)));
          await setPool(list);
          sendResponse({ ok: true, pool: list, removed: keys.size });
          break;
        }

        case 'remove-expired': {
          const now = Date.now();
          const before = await getPool();
          const list = before.filter((r) => !r.expiresAt || r.expiresAt > now);
          await setPool(list);
          sendResponse({ ok: true, pool: list, removed: before.length - list.length });
          break;
        }

        case 'clean-garbage': {
          // 清掉两种东西：已经过期的，和压根不像 token 的（历史脏数据）
          const now = Date.now();
          const before = await getPool();
          const kept = [];
          const dropped = [];

          for (const r of before) {
            const expired = r.expiresAt && r.expiresAt <= now;
            const garbage = !plausibleToken(r.access_token);
            if (expired || garbage) {
              dropped.push({
                name: r.nickname || String(r.uid || '').slice(0, 12) || '(未命名)',
                reason: expired ? '已过期' : '不是 token',
              });
            } else {
              kept.push(r);
            }
          }

          await setPool(kept);
          sendResponse({ ok: true, pool: kept, removed: dropped.length, dropped: dropped.slice(0, 20) });
          break;
        }

        case 'clear-pool': {
          await setPool([]);
          sendResponse({ ok: true });
          break;
        }

        case 'clear-captured': {
          await setCaptured([]);
          sendResponse({ ok: true });
          break;
        }

        case 'refresh-all': {
          const list = (await getPool()).filter((r) => r.enabled !== false);
          const now = Date.now();
          const custom = await getCustom();
          const isDeviceRow = (r) => platformById(r.platform, custom)?.mode === 'device';
          const targets = msg.force
            ? list.filter((r) => r.refresh_token && isDeviceRow(r))
            : list.filter((r) => needsRefresh(r, now));

          // 串行，不并发。同一个号并发续期会让后一个拿着已作废的 refresh_token 去换。
          const fails = [];
          let ok = 0;
          for (const row of targets) {
            const name = row.nickname || String(row.uid || '').slice(0, 8);
            const r = await deviceRefresh(row);
            if (r.ok) ok++; else fails.push(`${name}: ${r.reason}`);
          }
          sendResponse({ ok: true, okCount: ok, fails, total: targets.length, pool: await getPool() });
          break;
        }

        case 'export': {
          const pool = await getPool();
          const onlyValid = !!msg.onlyValid;
          const onlyPlatform = msg.platform || '';
          const keys = Array.isArray(msg.keys) ? new Set(msg.keys) : null;
          const now = Date.now();

          let rows0 = pool.filter((r) => r.enabled !== false);
          if (keys) rows0 = rows0.filter((r) => keys.has(rowKey(r)));
          else if (onlyPlatform) rows0 = rows0.filter((r) => r.platform === onlyPlatform);
          if (onlyValid) rows0 = rows0.filter((r) => (r.expiresAt || 0) > now);

          const allWb = rows0.length > 0 && rows0.every((r) => r.auth_raw);
          const fmt = msg.format && msg.format !== 'auto'
            ? msg.format
            : (allWb ? 'device' : 'generic');

          let out;
          if (fmt === 'raw') {
            out = rows0.map((r) => r.access_token);
          } else if (fmt === 'bearer') {
            out = rows0.map((r) => 'Bearer ' + r.access_token);
          } else if (fmt === 'device') {
            out = rows0.filter((r) => r.auth_raw).map(toDeviceExport);
          } else if (fmt === 'curl') {
            out = rows0.map((r) => {
              const p = platformById(r.platform, []);
              const base = p ? p.origin : ('https://' + (r.domain || ''));
              return `curl '${base}/v2/plugin/login/account' \\\n`
                + `  -H 'Authorization: Bearer ${r.access_token}' \\\n`
                + `  -H 'Accept: application/json'`;
            });
          } else if (fmt === 'env') {
            out = rows0.map((r, i) => {
              const tag = (r.nickname || r.uid || 'token').toString()
                .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
                .toUpperCase().slice(0, 20) || ('T' + (i + 1));
              return `${tag}_TOKEN=${r.access_token}`
                + (r.refresh_token ? `\n${tag}_REFRESH=${r.refresh_token}` : '');
            });
          } else if (fmt === 'postman') {
            out = {
              info: {
                name: '凭证导出 ' + new Date().toISOString().slice(0, 10),
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
              },
              item: rows0.map((r) => ({
                name: (r.nickname || r.uid || 'token').toString().slice(0, 40),
                request: {
                  method: 'GET',
                  header: [
                    { key: 'Authorization', value: 'Bearer ' + r.access_token },
                    { key: 'Accept', value: 'application/json' },
                  ],
                  url: (platformById(r.platform, [])?.origin || ('https://' + (r.domain || ''))),
                },
              })),
            };
          } else {
            out = rows0.map(toGenericExport);
          }

          sendResponse({
            ok: true,
            format: fmt,
            rows: out,
            count: rows0.length,
            skipped: pool.length - rows0.length,
          });
          break;
        }

        case 'reveal': {
          const pool = await getPool();
          const row = pool.find((r) => rowKey(r) === msg.key);
          if (!row) return sendResponse({ ok: false, error: '找不到该凭证' });
          sendResponse({ ok: true, row });
          break;
        }

        case 'check': {
          // 拿 token 打一次静默接口，看它还活着没
          const pool = await getPool();
          const row = pool.find((r) => rowKey(r) === msg.key);
          if (!row) return sendResponse({ ok: false, error: '找不到该凭证' });

          const platform = platformById(row.platform, await getCustom());
          if (!platform || platform.mode !== 'device') {
            // 抓来的凭证没有统一的校验口子，只能看本地到期时间。
            // 注意：没有 expiresAt（0）不等于过期 —— 那是「不知道什么时候过期」，
            // 界面显示「无期限」，这里不能判死，否则和界面自相矛盾。
            if (!row.expiresAt) {
              return sendResponse({
                ok: true,
                alive: true,
                method: 'unknown',
                detail: '无到期时间（本地无法判断）',
              });
            }
            const alive = row.expiresAt > Date.now();
            return sendResponse({
              ok: true,
              alive,
              method: 'local',
              detail: alive ? '未过期（本地判断）' : '已过期（本地判断）',
            });
          }

          try {
            const { status, json } = await jsonFetch(platform.origin + DEVICE_PATH.account, {
              headers: { ...COMMON_HEADERS, Authorization: 'Bearer ' + row.access_token },
            });
            const alive = status === 200 && json?.code === 0;
            sendResponse({
              ok: true,
              alive,
              method: 'remote',
              detail: alive ? '有效（服务端确认）' : (json?.msg || ('HTTP ' + status)),
            });
          } catch (e) {
            sendResponse({ ok: true, alive: false, method: 'remote', detail: e.message || '请求失败' });
          }
          break;
        }

        case 'stats': {
          const pool = await getPool();
          const captured = await getCaptured();
          const now = Date.now();
          const byPlatform = {};
          let expired = 0;
          let expiringSoon = 0;
          let withRefresh = 0;
          let disabled = 0;

          for (const r of pool) {
            byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1;
            const left = (r.expiresAt || 0) - now;
            if (r.enabled === false) { disabled++; continue; }
            if (r.expiresAt && left <= 0) expired++;
            else if (r.expiresAt && left < 3 * 86400000) expiringSoon++;
            if (r.refresh_token) withRefresh++;
          }

          sendResponse({
            ok: true,
            stats: { pool: pool.length, captured: captured.length, expired, expiringSoon, withRefresh, disabled, byPlatform },
          });
          break;
        }

        case 'check-all': {
          // 整池体检：设备模式的走服务端，抓来的看本地到期
          const pool = await getPool();
          const custom = await getCustom();
          const results = [];
          let alive = 0;
          let dead = 0;
          let unknown = 0;

          for (const row of pool) {
            const platform = platformById(row.platform, custom);
            const key = rowKey(row);
            const name = row.nickname || String(row.uid || '').slice(0, 10);

            if (!platform || platform.mode !== 'device') {
              // 没有到期时间的抓取凭证：本地判断不了，单独归一类，别混进「失效」
              if (!row.expiresAt) {
                results.push({ key, name, alive: true, method: 'unknown', detail: '无到期时间' });
                unknown++;
                continue;
              }
              const ok = row.expiresAt > Date.now();
              results.push({ key, name, alive: ok, method: 'local', detail: ok ? '未过期' : '已过期' });
              if (ok) alive++; else dead++;
              continue;
            }

            try {
              const { status, json } = await jsonFetch(platform.origin + DEVICE_PATH.account, {
                headers: { ...COMMON_HEADERS, Authorization: 'Bearer ' + row.access_token },
              });
              const ok = status === 200 && json?.code === 0;
              results.push({
                key, name, alive: ok, method: 'remote',
                detail: ok ? '有效' : (json?.msg || ('HTTP ' + status)),
              });
              if (ok) alive++; else dead++;
            } catch (e) {
              results.push({ key, name, alive: false, method: 'remote', detail: e.message || '请求失败' });
              dead++;
            }
          }

          sendResponse({ ok: true, results, alive, dead, unknown, total: pool.length });
          break;
        }

        case 'should-capture': {
          // 全站模式直接放行；白名单模式只放行列表里的站点
          const settings = await getSettings();
          const host = String(msg.host || '').toLowerCase();
          if (settings.captureAll !== false) {
            return sendResponse({ ok: true, enabled: true, mode: 'all' });
          }
          const list = Array.isArray(settings.allowHosts) ? settings.allowHosts : [];
          const hit = list.some((h) => {
            const p = String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            return p && (host === p || host.endsWith('.' + p));
          });
          sendResponse({ ok: true, enabled: hit, mode: 'allowlist' });
          break;
        }

        case 'get-site-rule': {
          const rules = await getSiteRules();
          const r = rules[msg.host] || {};
          sendResponse({
            ok: true,
            hook: r.hook !== false,          // 默认开
            snapshot: r.snapshot !== false,  // 默认开
            restore: r.restore !== false,    // 默认开
            rule: r,
          });
          break;
        }

        case 'set-site-rule': {
          const rules = await getSiteRules();
          const cur = { ...(rules[msg.host] || {}) };
          // 三个开关各自独立，只更新传进来的那几个
          for (const k of ['hook', 'snapshot', 'restore']) {
            if (k in msg) cur[k] = !!msg[k];
          }
          // 全都回到默认值就把这条规则删掉，别留垃圾
          const isDefault = ['hook', 'snapshot', 'restore'].every((k) => cur[k] !== false);
          if (isDefault) delete rules[msg.host];
          else rules[msg.host] = cur;
          await chrome.storage.local.set({ [K.siteRules]: rules });
          sendResponse({ ok: true, rules, rule: cur });
          break;
        }

        case 'list-site-rules': {
          sendResponse({ ok: true, rules: await getSiteRules() });
          break;
        }

        case 'toggle-enabled': {
          const list = await getPool();
          const row = list.find((r) => rowKey(r) === msg.key);
          if (!row) return sendResponse({ ok: false, error: '找不到该凭证' });
          row.enabled = msg.enabled === undefined ? !(row.enabled !== false) : !!msg.enabled;
          await setPool(list);
          updateBadge();
          sendResponse({ ok: true, enabled: row.enabled, pool: list });
          break;
        }

        case 'refresh-one': {
          const list = await getPool();
          const row = list.find((r) => rowKey(r) === msg.key);
          if (!row) return sendResponse({ ok: false, error: '找不到该凭证' });
          const r = await deviceRefresh(row);
          updateBadge();
          sendResponse({ ok: r.ok, reason: r.reason, row: r.row });
          break;
        }

        case 'add-note': {
          const list = await getPool();
          const row = list.find((r) => rowKey(r) === msg.key);
          if (!row) return sendResponse({ ok: false, error: '找不到该凭证' });
          row.note = String(msg.note || '').slice(0, 200);
          await setPool(list);
          sendResponse({ ok: true });
          break;
        }

        case 'backup': {
          const data = {
            version: 2,
            exportedAt: new Date().toISOString(),
            accounts: await getPool(),
            custom: await getCustom(),
            settings: await getSettings(),
            siteRules: await getSiteRules(),
          };
          sendResponse({ ok: true, data });
          break;
        }

        case 'restore': {
          const d = msg.data || {};
          if (!Array.isArray(d.accounts)) {
            return sendResponse({ ok: false, error: '文件格式不对，缺少 accounts' });
          }

          // 合并而不是覆盖：同 uid 的用文件里的，其余保留
          const cur = await getPool();
          const map = new Map(cur.map((r) => [rowKey(r), r]));
          let added = 0;
          let updated = 0;
          for (const r of d.accounts) {
            if (!r || !r.access_token) continue;
            const k = rowKey(r);
            if (map.has(k)) updated++; else added++;
            map.set(k, r);
          }
          await setPool([...map.values()]);

          if (Array.isArray(d.custom) && d.custom.length) {
            await chrome.storage.local.set({ [K.custom]: d.custom });
          }
          if (d.settings && typeof d.settings === 'object') {
            const s = await getSettings();
            await chrome.storage.local.set({ [K.settings]: { ...s, ...d.settings } });
          }
          if (d.siteRules && typeof d.siteRules === 'object') {
            const r0 = await getSiteRules();
            await chrome.storage.local.set({ [K.siteRules]: { ...r0, ...d.siteRules } });
          }

          updateBadge();
          sendResponse({ ok: true, added, updated, total: map.size });
          break;
        }

        case 'save-settings': {
          const cur = await getSettings();
          const next = { ...cur, ...msg.settings };
          await chrome.storage.local.set({ [K.settings]: next });
          sendResponse({ ok: true, settings: next });
          break;
        }

        /* ---------- 会话快照 ---------- */

        case 'session-list': {
          sendResponse({ ok: true, sessions: await listSessions() });
          break;
        }

        case 'session-snapshot': {
          const tabId = msg.tabId || sender.tab?.id;
          if (!tabId) return sendResponse({ ok: false, error: '拿不到标签页' });
          const host = msg.host || hostOf(sender.tab?.url || '');
          const r = await snapshotSession(host, tabId);
          sendResponse(r);
          break;
        }

        case 'session-restore': {
          const tabId = msg.tabId || sender.tab?.id;
          if (!tabId) return sendResponse({ ok: false, error: '拿不到标签页' });
          const host = msg.host || hostOf(sender.tab?.url || '');
          sendResponse(await restoreSession(host, tabId, msg.who));
          break;
        }

        case 'session-remove': {
          sendResponse({ ok: true, sessions: await removeSession(msg.host, msg.who) });
          break;
        }

        case 'session-clear': {
          sendResponse({ ok: true, sessions: await clearSessions() });
          break;
        }

        case 'session-export': {
          sendResponse({ ok: true, data: await exportSessions(msg.hosts) });
          break;
        }

        case 'session-import': {
          sendResponse(await importSessions(msg.data, { replace: !!msg.replace }));
          break;
        }

        case 'session-current': {
          // 当前标签页有没有快照，popup 打开时要立刻知道
          const tabId = msg.tabId || sender.tab?.id;
          const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
          const host = msg.host || hostOf(tab?.url || '');
          const map = await listSessions();
          sendResponse({
            ok: true, host, tabId: tabId || null, has: !!map[host], snap: map[host] || null,
          });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message: ' + msg?.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

function safeHost(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

// 右键菜单：扫凭证 / 存登录态 / 恢复登录态
function buildMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'tk-scan',
        title: '扫描本页凭证',
        contexts: ['page', 'selection', 'link'],
      });
      chrome.contextMenus.create({
        id: 'tk-snap',
        title: '存下本站登录态',
        contexts: ['page'],
      });
      chrome.contextMenus.create({
        id: 'tk-restore',
        title: '恢复本站登录态',
        contexts: ['page'],
      });
      chrome.contextMenus.create({ id: 'tk-sep', type: 'separator', contexts: ['page'] });
      chrome.contextMenus.create({
        id: 'tk-open',
        title: '打开凭证面板',
        contexts: ['page'],
      });
    });
  } catch (e) {}
}

// 菜单里点「扫描」时真把结果收进池子，而不是只弹个空窗
async function scanIntoPool(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  const host = safeHost(tab.url);
  const cookies = await scanCookies(host).catch(() => []);
  // 内容脚本那边可能还在跑，给它一点时间把页面里的东西交上来
  await new Promise((r) => setTimeout(r, 600));
  return { ok: true, cookies: cookies.length };
}

try {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;
    const id = info.menuItemId;
    const host = hostOf(tab.url || '');
    try {
      if (id === 'tk-scan') {
        chrome.tabs.sendMessage(tab.id, { type: 'rescan-page' }).catch(() => {});
        await scanIntoPool(tab.id);
        chrome.action.openPopup?.().catch(() => {});
      } else if (id === 'tk-snap') {
        if (!host) return;
        await snapshotSession(host, tab.id).catch(() => {});
        chrome.action.openPopup?.().catch(() => {});
      } else if (id === 'tk-restore') {
        if (!host) return;
        await restoreSession(host, tab.id).catch(() => {});
      } else if (id === 'tk-open') {
        chrome.action.openPopup?.().catch(() => {});
      }
    } catch (e) {}
  });
} catch (e) {}

chrome.runtime.onInstalled.addListener(async () => {
  buildMenus();
  const cur = await getSettings();
  await chrome.storage.local.set({ [K.settings]: { showFloatingPanel: false, autoRefresh: true, ...cur } });
  setupAlarms().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  buildMenus();
  setupAlarms().catch(() => {});
  maybeAutoRefresh().catch(() => {});
  updateBadge().catch(() => {});
});

// 只在这里跑一次的话，SW 一被杀就再也不会有下次了。
// 真正的周期任务必须挂在 alarms 上，由浏览器叫醒。
setupAlarms().catch(() => {});
maybeAutoRefresh().catch(() => {});

const ALARM_TICK = 'tk-tick';

async function setupAlarms() {
  try {
    const existing = await chrome.alarms.get(ALARM_TICK);
    if (existing) return;
    // 30 分钟一次。SW 被杀掉也不影响，到点浏览器会把它拉起来。
    await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 30, delayInMinutes: 1 });
  } catch (e) {}
}

try {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name !== ALARM_TICK) return;
    maybeAutoRefresh().catch(() => {});
    updateBadge().catch(() => {});
  });
} catch (e) {}

// 页面加载完做两件事：补写排队中的 storage；顺手自动存一份会话快照
try {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete' || !tab?.url) return;
    if (info.frameId) return; // 只认主框架，iframe 也会触发这个事件
    resumePending(tabId, tab.url).catch(() => {});
    maybeAutoSnapshot(tabId, tab.url).catch(() => {});
  });
} catch (e) {}

async function maybeAutoSnapshot(tabId, url) {
  const settings = await getSettings();
  if (settings.autoSnapshot === false) return;
  const host = hostOf(url);
  if (!host) return;
  // 没有点的主机名是浏览器内部页或单机名，不是登录态
  if (!/\./.test(host) && host !== 'localhost') return;
  const rules = await getSiteRules();
  if (rules[host]?.snapshot === false) return;

  // 先看能不能自动救回来。救回来会刷新页面，这时不要再存快照，
  // 否则刚写回的东西可能被页面初始化过程中的中间态覆盖掉
  if (settings.autoRestore !== false) {
    const r = await maybeAutoRestore(host, tabId).catch(() => null);
    if (r?.ok && (r.reloading || r.navigating)) return;
  }

  await autoSnapshot(host, tabId).catch(() => {});
}

// 整页加载只在导航时触发。单页应用登录完不会刷新页面，
// 光靠 onUpdated 的话这类站点永远存不下快照。
// 这里盯着登录接口的响应头，Set-Cookie 一出现就说明刚换了会话。
const LOGIN_URL_HINT = /(login|signin|sign-in|auth|session|passport|oauth|token|account)/i;
let lastLoginSnapAt = 0;

try {
  chrome.webRequest.onCompleted.addListener((d) => {
    if (d.tabId < 0 || d.frameId) return;
    if (!/^https?:/.test(d.url || '')) return;
    if (!LOGIN_URL_HINT.test(d.url)) return;

    const sc = (d.responseHeaders || []).filter((h) => /^set-cookie$/i.test(h.name || ''));
    if (!sc.length) return;

    // 一个登录流程常常连着好几个请求，攒一下只存一次
    const now = Date.now();
    if (now - lastLoginSnapAt < 4000) return;
    lastLoginSnapAt = now;

    setTimeout(() => {
      maybeAutoSnapshot(d.tabId, d.url).catch(() => {});
    }, 1200);
    // Set-Cookie 属于「额外」响应头，不显式要的话 onCompleted 里看不到
  }, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders', 'extraHeaders']);
} catch (e) {}

// 有些站点用着用着才把会话踢掉（后台过期、异地登录互踢），
// 这时候不会重新加载页面，光靠 onUpdated 要等用户自己刷新才发现。
// 这里盯 401/403，一出现就试一次自动恢复。
const recentAuthFail = new Map(); // host -> 上次处理时间

try {
  chrome.webRequest.onCompleted.addListener((d) => {
    if (d.tabId < 0 || d.frameId) return;
    if (d.statusCode !== 401 && d.statusCode !== 403) return;
    if (!/^https?:/.test(d.url || '')) return;

    let host = '';
    try { host = new URL(d.url).hostname; } catch (e) { return; }
    if (!host) return;

    // 一个页面失效时常并发打一堆请求，攒成一次
    const now = Date.now();
    if (now - (recentAuthFail.get(host) || 0) < 30000) return;
    recentAuthFail.set(host, now);
    if (recentAuthFail.size > 200) recentAuthFail.clear();

    setTimeout(() => {
      tryRestore(d.tabId, d.url).catch(() => {});
    }, 800);
  }, { urls: ['http://*/*', 'https://*/*'] });
} catch (e) {}

/** 掉线后试一次自动恢复；恢复不动就什么也别做，别把快照覆盖成登出态 */
async function tryRestore(tabId, url) {
  const settings = await getSettings();
  if (settings.autoRestore === false) return;
  const host = hostOf(url);
  if (!host) return;
  if (!/\./.test(host) && host !== 'localhost') return;
  const rules = await getSiteRules();
  if (rules[host]?.restore === false) return;
  await maybeAutoRestore(host, tabId).catch(() => {});
}

// 12 小时最多续一次，免得频繁刷新把号刷进风控
async function maybeAutoRefresh() {
  const settings = await getSettings();
  if (!settings.autoRefresh) return;
  const { [K.autoRefreshAt]: last = 0 } = await chrome.storage.local.get(K.autoRefreshAt);
  if (Date.now() - last < 12 * 3600 * 1000) return;

  const list = await getPool();
  const targets = list.filter((r) => r.enabled !== false && needsRefresh(r));
  if (!targets.length) return;

  await chrome.storage.local.set({ [K.autoRefreshAt]: Date.now() });
  for (const row of targets) {
    await deviceRefresh(row).catch(() => {});
  }
  updateBadge().catch(() => {});
}
