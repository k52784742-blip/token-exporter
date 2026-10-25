/**
 * 通用工具：JWT 解析、时间换算、凭证行组装、导出格式
 */

export function b64urlDecode(seg) {
  try {
    let s = String(seg).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) { return null; }
}

export function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return {};
  const txt = b64urlDecode(parts[1]);
  if (!txt) return {};
  try { return JSON.parse(txt) || {}; } catch (e) { return {}; }
}

/**
 * 判断是不是 JWT。
 * 不校验签名段长度：alg=none 的 JWT 签名段是空的，合法但很短。
 */
export function looksJwt(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 20) return false;
  const parts = s.split('.');
  if (parts.length !== 3) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  if (parts[2] && !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
  const claims = parseJwt(s);
  if (!claims || typeof claims !== 'object') return false;
  return Boolean(claims.exp || claims.sub || claims.iss || claims.iat
    || claims.name || claims.email || claims.user_id);
}

export function normalizeEpoch(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

export function humanLeft(ms) {
  if (!ms || ms <= 0) return '已过期';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d > 0) return d + ' 天';
  if (h > 0) return h + ' 小时';
  return Math.max(1, Math.floor(ms / 60000)) + ' 分钟';
}

export function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function escapeHtmlSafe(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 凭证行的唯一键 */
export function rowKey(row) {
  return (row.platform || '') + '|' + (row.uid || String(row.access_token || '').slice(-16));
}

/** WorkBuddy 格式：顶层毫秒，auth_raw.auth 内秒 */
export function buildWorkbuddyRow(accessToken, refreshToken, profile, platform, expiryHint) {
  const claims = parseJwt(accessToken);
  const rclaims = parseJwt(refreshToken);

  const domain = String(platform?.domain || '');
  const uid = String(profile?.uid || claims.sub || '').trim();
  const nickname = String(profile?.nickname || claims.nickname || '');

  const expSec = normalizeEpoch(expiryHint?.expiresAt) || Number(claims.exp) || 0;
  const rexpSec = normalizeEpoch(expiryHint?.refreshExpiresAt) || Number(rclaims.exp) || 0;

  return {
    platform: platform?.id || 'workbuddy-cn',
    access_token: accessToken,
    refresh_token: refreshToken,
    uid,
    nickname,
    domain,
    expiresAt: expSec * 1000,
    refreshExpiresAt: rexpSec * 1000,
    auth_raw: {
      auth: {
        accessToken,
        refreshToken,
        expiresAt: expSec,
        refreshExpiresAt: rexpSec,
        domain,
      },
      account: {
        uid,
        nickname,
        uin: String(profile?.uin || ''),
      },
    },
  };
}

/** 通用格式：不猜字段，原样保留 */
export function buildGenericRow(accessToken, refreshToken, info = {}) {
  const claims = parseJwt(accessToken);
  const rclaims = parseJwt(refreshToken);
  const expSec = Number(claims.exp) || 0;
  const rexpSec = Number(rclaims.exp) || 0;
  return {
    platform: info.platform || 'site',
    access_token: accessToken,
    refresh_token: refreshToken || '',
    uid: String(info.uid || claims.sub || ''),
    nickname: String(info.nickname || claims.nickname || claims.name || ''),
    domain: String(info.domain || ''),
    expiresAt: expSec * 1000,
    refreshExpiresAt: rexpSec * 1000,
    source: info.source || 'capture',
    claims,
    extra: info.extra || undefined,
  };
}

/** WorkBuddy 原生格式：只保留 8 个键，顺序固定 */
export function toWorkbuddyExport(row) {
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    uid: row.uid,
    nickname: row.nickname,
    domain: row.domain,
    expiresAt: row.expiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    auth_raw: row.auth_raw,
  };
}

export function toGenericExport(row) {
  return {
    platform: row.platform,
    domain: row.domain,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    uid: row.uid,
    nickname: row.nickname,
    expiresAt: row.expiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    source: row.source || undefined,
    claims: row.claims || parseJwt(row.access_token),
  };
}

/* ==========================================================================
 * 增强工具（v3.2）
 * ========================================================================*/

/**
 * 把毫秒差格式化成紧凑的中文时长。
 * 相比 humanLeft 更细：区分「刚刚 / 分钟 / 小时 / 天 / 月」。
 */
export function humanLeftLong(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) {
    const ago = Math.abs(ms);
    const d = Math.floor(ago / 86400000);
    if (d >= 1) return `已过期 ${d} 天`;
    const h = Math.floor(ago / 3600000);
    if (h >= 1) return `已过期 ${h} 小时`;
    return '刚刚过期';
  }
  const d = Math.floor(ms / 86400000);
  if (d >= 1) {
    const h = Math.floor((ms % 86400000) / 3600000);
    return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
  }
  const h = Math.floor(ms / 3600000);
  if (h >= 1) {
    const m = Math.floor((ms % 3600000) / 60000);
    return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }
  const m = Math.floor(ms / 60000);
  return m >= 1 ? `${m} 分钟` : '不到 1 分钟';
}

/** 到期状态的语义分级 */
export function expiryLevel(expiresAt, now = Date.now()) {
  if (!expiresAt) return 'none';
  const left = expiresAt - now;
  if (left <= 0) return 'expired';
  if (left < 3600 * 1000) return 'urgent';       // < 1 小时
  if (left < 3 * 86400000) return 'warning';      // < 3 天
  if (left < 14 * 86400000) return 'soon';        // < 14 天
  return 'healthy';
}

/** 脱敏显示 token：eyJhbGci…kZCI6 */
export function maskToken(token, keep = 8) {
  const s = String(token || '');
  if (s.length <= keep * 2 + 3) return s.slice(0, 6) + '…';
  return s.slice(0, keep) + '…' + s.slice(-4);
}

/** 从 JWT 里抽可读身份信息 */
export function jwtIdentity(token) {
  const c = parseJwt(token);
  return {
    name: c.name || c.nickname || c.preferred_username || '',
    email: c.email || '',
    sub: c.sub || '',
    iss: c.iss || '',
    aud: Array.isArray(c.aud) ? c.aud.join(',') : (c.aud || ''),
    exp: Number(c.exp) || 0,
    iat: Number(c.iat) || 0,
    scopes: typeof c.scope === 'string' ? c.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/** 相对时间：3 分钟前 */
export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const d = now - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

/** 按到期时间排序：紧急的在前 */
export function sortByUrgency(rows, now = Date.now()) {
  return rows.slice().sort((a, b) => {
    const ea = a.expiresAt || 0;
    const eb = b.expiresAt || 0;
    if (!ea && !eb) return 0;
    if (!ea) return 1;
    if (!eb) return -1;
    return ea - eb;
  });
}

/** 复制到剪贴板，带回退 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}


/** 把各种导入形态抹平 */
export function normalizeImport(obj, platformHint) {
  if (!obj || typeof obj !== 'object') throw new Error('不是对象');

  const auth = obj.auth_raw?.auth || obj.auth || {};
  const acct = obj.auth_raw?.account || obj.account || {};

  const accessToken = String(
    obj.access_token || obj.accessToken || auth.accessToken || obj.token || ''
  ).trim();
  const refreshToken = String(
    obj.refresh_token || obj.refreshToken || auth.refreshToken || ''
  ).trim();

  if (!accessToken) throw new Error('缺少 access_token / accessToken');

  // 明显不是凭证的东西直接拒掉。以前只检查非空，粘错东西也能进池子。
  if (accessToken.length < 16) throw new Error('access_token 太短，不像凭证');
  if (/\s/.test(accessToken)) throw new Error('access_token 里有空格，格式不对');
  if (/^https?:\/\//i.test(accessToken)) throw new Error('这是网址，不是 token');
  if (/^(true|false|null|undefined)$/i.test(accessToken)) throw new Error('不是凭证');

  const domain = obj.domain || auth.domain || '';

  if (platformHint && platformHint.mode === 'device') {
    const row = buildWorkbuddyRow(accessToken, refreshToken, {
      uid: obj.uid || acct.uid || '',
      nickname: obj.nickname || acct.nickname || '',
      uin: obj.uin || acct.uin || '',
    }, platformHint);
    if (!row.expiresAt) {
      const e = normalizeEpoch(obj.expiresAt || auth.expiresAt || 0);
      if (e) row.expiresAt = e * 1000;
    }
    if (!row.refreshExpiresAt) {
      const re = normalizeEpoch(obj.refreshExpiresAt || auth.refreshExpiresAt || 0);
      if (re) row.refreshExpiresAt = re * 1000;
    }
    return row;
  }

  return buildGenericRow(accessToken, refreshToken, {
    platform: obj.platform || (platformHint ? platformHint.id : 'site'),
    uid: obj.uid || acct.uid || '',
    nickname: obj.nickname || acct.nickname || '',
    domain,
    source: 'import',
    extra: obj.extra,
  });
}
