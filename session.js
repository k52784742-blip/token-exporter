// 会话快照：把一个站点的登录态整包存下来，之后原样写回去。
//
// 光有 token 是回不到「已登录」的 —— token 只能拿去调接口，浏览器不会因为它
// 就变成登录状态。真正决定登录态的是 cookie（包括 JS 读不到的 HttpOnly 那些）
// 加上页面 storage 里的会话信息。这里把两部分一起收齐，恢复时先写 cookie，
// 再写 storage，最后刷新一次，页面就回到当初的样子了。

export const SESSION_KEY = 'sessions_v1';
const PENDING_KEY = 'pending_restore_v1';

export const MAX_HOSTS = 80;
const MAX_ONE_BYTES = 3 * 1024 * 1024;

// 判断这个站点的快照里有没有「看起来像登录态」的东西，界面上用来给个提示
const AUTH_HINT = /(sess|auth|token|sid|login|credential|jwt|passport|ticket|uid|user)/i;

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

export async function listSessions() {
  const { [SESSION_KEY]: raw } = await chrome.storage.local.get(SESSION_KEY);
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

async function saveMap(map) {
  const keys = Object.keys(map);
  if (keys.length > MAX_HOSTS) {
    keys.sort((a, b) => (map[a]?.at || 0) - (map[b]?.at || 0));
    for (const k of keys.slice(0, keys.length - MAX_HOSTS)) delete map[k];
  }
  await chrome.storage.local.set({ [SESSION_KEY]: map });
  return map;
}

/* ---------------- cookie ---------------- */

// chrome.cookies.set 有几个坑：
//   __Host- 开头的 cookie 不许带 domain，且必须 secure + path=/
//   __Secure- 开头的必须 secure
//   sameSite=no_restriction 必须搭配 secure
// 任何一条不满足，Chrome 直接整条拒收（返回 null），不会告诉你哪条错了。
// 所以先按原样拼，失败再降级重试一次。
export function setDetailsFor(c, fallbackHost) {
  const domain = c.domain || fallbackHost;
  const host = domain.replace(/^\./, '');
  const hostOnly = !!c.hostOnly;
  const prefixed = /^__(Host|Secure)-/i.test(c.name);
  // SameSite=None 不带 Secure 会被 Chrome 整条拒收，这里顺手补上
  const secure = !!c.secure || prefixed || c.sameSite === 'no_restriction';
  const url = (secure ? 'https' : 'http') + '://' + host + (c.path || '/');

  const d = {
    url,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure,
  };
  // hostOnly 的 cookie 不能带 domain：一带上就变成对所有子域可见，
  // 写回之后行为跟原来不一样，有些站点会因此判成另一个会话。
  if (!hostOnly && !/^__Host-/i.test(c.name)) d.domain = domain;
  if (c.httpOnly) d.httpOnly = true;
  if (c.sameSite && c.sameSite !== 'unspecified') d.sameSite = c.sameSite;
  // 快照可能是几天前存的，里面短期 cookie 的过期时间早就过了。
  // 原样写回去 Chrome 会静默拒收（返回 null），恢复就变成「点了没反应」。
  // 这种情况降级成会话 cookie：浏览器开着就有效，够把登录态救回来。
  if (c.expirationDate) {
    if (c.expirationDate * 1000 > Date.now()) d.expirationDate = c.expirationDate;
    else d.expiredAtSnapshot = true;
  }
  if (c.partitionKey) d.partitionKey = c.partitionKey;
  return d;
}

async function putCookie(d) {
  try {
    const r = await chrome.cookies.set(d);
    if (r) return true;
  } catch (e) {}

  // 降级：去掉 sameSite / partitionKey / domain 里可能不合规的部分
  const minimal = {
    url: d.url, name: d.name, value: d.value, path: d.path, secure: d.secure,
  };
  if (d.httpOnly) minimal.httpOnly = true;
  if (d.expirationDate) minimal.expirationDate = d.expirationDate;
  if (d.domain && !/^__Host-/i.test(d.name)) minimal.domain = d.domain;
  try {
    const r2 = await chrome.cookies.set(minimal);
    return !!r2;
  } catch (e) { return false; }
}

async function writeCookies(snap, host) {
  const list = Array.isArray(snap.cookies) ? snap.cookies : [];
  let ok = 0;
  const failed = [];
  for (const c of list) {
    if (!c || !c.name) continue;
    const good = await putCookie(setDetailsFor(c, host));
    if (good) ok++;
    else failed.push(c.name);
  }
  return { cookies: ok, cookieFailed: failed.slice(0, 12) };
}

/* ---------------- 页面 storage ---------------- */

// 内容脚本里读得到 localStorage，但拿不到 HttpOnly cookie —— 两边正好互补。
async function askStorage(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'dump-storage' }, { frameId: 0 });
    if (r && r.ok && r.data) return r.data;
  } catch (e) {}

  // 页面把内容脚本挡掉时（少见），退回注入执行
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const out = { local: {}, session: {} };
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            out.local[k] = localStorage.getItem(k);
          }
        } catch (e) {}
        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            out.session[k] = sessionStorage.getItem(k);
          }
        } catch (e) {}
        return out;
      },
    });
    return res?.result || null;
  } catch (e) { return null; }
}

async function writeStorage(tabId, snap) {
  const data = snap.storage || { local: {}, session: {} };
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'apply-storage', data }, { frameId: 0 });
    if (r && r.ok) return r.count || 0;
  } catch (e) {}

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (d) => {
        let n = 0;
        try {
          localStorage.clear();
          for (const k in d.local || {}) { localStorage.setItem(k, d.local[k]); n++; }
        } catch (e) {}
        try {
          sessionStorage.clear();
          for (const k in d.session || {}) { sessionStorage.setItem(k, d.session[k]); n++; }
        } catch (e) {}
        return n;
      },
      args: [data],
    });
    return res?.result || 0;
  } catch (e) { return 0; }
}

/* ---------------- 快照 / 恢复 ---------------- */

// 猜这份快照是谁的。多个账号在同一站点上换来换去时，
// 列表里只显示域名根本分不出哪个是哪个。
// 顺序有讲究：先找人名，再退回 id。uid 那种一串数字看不出是谁，
// 但在没有昵称的时候总比空着强。
const WHO_NAME_KEYS = ['nickname', 'nickName', 'nick', 'displayName', 'display_name', 'userName', 'username', 'uname', 'name', 'email', 'account', 'login'];
const WHO_ID_KEYS = ['uid', 'user_?id', 'userId', 'uin', 'memberId'];

function pickScalar(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const re = new RegExp('^' + k + '$', 'i');
    for (const key of Object.keys(obj)) {
      if (!re.test(key)) continue;
      const v = obj[key];
      if (v == null || typeof v === 'object') continue;
      const s = String(v).trim();
      // 太长的多半是 token 或者序列化后的东西，不是人名
      if (s && s.length <= 40 && !/^ey[A-Za-z0-9_-]{10,}/.test(s)) return s;
    }
  }
  return '';
}

function guessWho(cookies, local) {
  // 先看 cookie：那是服务端下发的，一定对应当前这个会话。
  // localStorage 在换账号时可能还留着上一个人的名字，信它会认错人。
  for (const c of cookies || []) {
    if (!/^(nick|nickname|username|displayname|uname|user)$/i.test(c.name)) continue;
    const v = String(c.value || '').trim();
    if (v && v.length <= 40 && !/^ey[A-Za-z0-9_-]{10,}/.test(v)) return v;
  }

  const fromStore = pickScalar(local, WHO_NAME_KEYS) || pickScalar(local, WHO_ID_KEYS);
  if (fromStore) return fromStore;

  // localStorage 里常见的嵌套用户对象
  for (const k of Object.keys(local || {})) {
    if (!/user|account|profile|login|member/i.test(k)) continue;
    const raw = local[k];
    if (typeof raw !== 'string' || raw[0] !== '{') continue;
    try {
      const o = JSON.parse(raw);
      for (const cand of [o, o.user, o.data, o.account, o.profile]) {
        const got = pickScalar(cand, WHO_NAME_KEYS) || pickScalar(cand, WHO_ID_KEYS);
        if (got) return got;
      }
    } catch (e) {}
  }
  return '';
}

export async function snapshotSession(host, tabId, opts = {}) {
  if (!host) return { ok: false, error: '拿不到站点域名' };

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const curHost = tab?.url ? hostOf(tab.url) : '';
  if (curHost && curHost !== host) {
    return { ok: false, error: '当前页面不在这个站点上' };
  }

  // 协议跟当前页面走：本地 http 站点如果按 https 去查，一条 cookie 都拿不到
  let proto = 'https';
  try {
    const u = new URL(tab?.url || '');
    if (u.protocol === 'http:') proto = 'http';
  } catch (e) {}

  let cookies = [];
  try {
    // 两个查询都要，少一个就会漏：
    //   {domain: host}  拿 host 自身和它下面子域的 cookie
    //   {url: ...} 拿「访问这个站点时浏览器会带上的」全部 cookie，
    //   这里包含设在父域上的（比如在 chat.example.com 上，.example.com 的
    //   SSO 会话 cookie 只有 url 查询能拿到，domain 查询拿不到）
    const [byDomain, byUrl] = await Promise.all([
      chrome.cookies.getAll({ domain: host }).catch(() => []),
      chrome.cookies.getAll({ url: proto + '://' + host + '/' }).catch(() => []),
    ]);
    const seen = new Set();
    for (const c of [...byDomain, ...byUrl]) {
      if (!c || !c.name) continue;
      const k = c.name + '|' + (c.domain || '') + '|' + (c.path || '/') + '|'
        + (c.partitionKey?.topLevelSite || '');
      if (seen.has(k)) continue;
      seen.add(k);
      cookies.push(c);
    }
  } catch (e) { return { ok: false, error: '读 cookie 失败：' + (e.message || e) }; }

  // 只要属于这个站点（含父域与子域）的，别把同浏览器其他站点的 cookie 混进来
  cookies = cookies.filter((c) => {
    if (!c || !c.name) return false;
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return !d || d === host || host.endsWith('.' + d) || d.endsWith('.' + host);
  });

  const storage = (await askStorage(tabId)) || { local: {}, session: {} };

  const snap = {
    host,
    at: Date.now(),
    url: tab?.url || ('https://' + host + '/'),
    ua: opts.ua || '',
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      // hostOnly 必须存：只对当前域名可见的 cookie 写回时若带上 domain，
      // 就会变成对全部子域可见，站点可能因此当成另一个会话
      hostOnly: !!c.hostOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
      session: !!c.session,
      partitionKey: c.partitionKey || undefined,
    })),
    storage: {
      local: storage.local || {},
      session: storage.session || {},
    },
    summary: {
      cookies: cookies.length,
      httpOnly: cookies.filter((c) => c.httpOnly).length,
      local: Object.keys(storage.local || {}).length,
      session: Object.keys(storage.session || {}).length,
      authLike: cookies.some((c) => AUTH_HINT.test(c.name))
        || Object.keys(storage.local || {}).some((k) => AUTH_HINT.test(k)),
      who: guessWho(cookies, storage.local || {}),
    },
  };

  const bytes = JSON.stringify(snap).length;
  if (bytes > MAX_ONE_BYTES) {
    return { ok: false, error: '这个站点的数据太大（' + Math.round(bytes / 1024) + ' KB），没有保存' };
  }
  snap.bytes = bytes;

  // dry：只算出来看看，不落盘。自动快照要靠它判断「值不值得存」
  if (opts.dry) return { ok: true, snap, host, dry: true };

  const map = await listSessions();
  map[host] = snap;
  await saveMap(map);
  return { ok: true, snap, host };
}

// 一个快照「像登录态」的程度。用来防止登出时把好快照覆盖成空的。
export function authScore(snap) {
  if (!snap) return 0;
  let n = 0;
  for (const c of snap.cookies || []) if (AUTH_HINT.test(c.name)) n += 2;
  for (const k of Object.keys(snap.storage?.local || {})) if (AUTH_HINT.test(k)) n += 1;
  return n;
}

export const AUTO_MIN_GAP = 5 * 60 * 1000;

// 同一站点上换账号时，旧快照不能就这么被顶掉 —— 收进 alts 里存着，随时能切回去
const MAX_ALTS = 5;

function sameWho(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  return !!x && !!y && x === y;
}

// 自动快照：页面加载完调一次。
// 关键点是「不许降级」——登出后 cookie 全没了，这时候存下去等于把能救命的
// 快照亲手删了。所以只要新状态比旧状态更不像登录态，就一律不写。
export async function autoSnapshot(host, tabId) {
  if (!host) return { ok: false, skipped: 'no-host' };

  const map = await listSessions();
  const old = map[host] || null;
  if (old && Date.now() - (old.autoAt || old.at || 0) < AUTO_MIN_GAP) {
    return { ok: false, skipped: 'too-soon' };
  }

  const r = await snapshotSession(host, tabId, { dry: true });
  if (!r.ok) return { ok: false, skipped: 'fail', error: r.error };

  const fresh = r.snap;
  const newScore = authScore(fresh);
  const oldScore = authScore(old);

  if (old && newScore < oldScore) {
    // 登出、被踢、会话过期都会走到这里 —— 保留旧快照
    return { ok: false, skipped: 'would-downgrade', newScore, oldScore };
  }
  if (!old && newScore === 0) {
    // 从没登录过的站点不值得占位置
    return { ok: false, skipped: 'no-auth' };
  }

  // 两边都是登录态、但人是两个：这是换账号，不是登出。
  // 把原来那份收进 alts，别让第二个账号把第一个账号顶掉。
  let switched = false;
  if (old && newScore > 0 && oldScore > 0
    && old.summary?.who && fresh.summary?.who
    && !sameWho(old.summary.who, fresh.summary.who)) {
    const alts = (old.alts || []).filter((a) => !sameWho(a?.summary?.who, fresh.summary.who));
    const keep = { ...old };
    delete keep.alts;
    alts.unshift(keep);
    fresh.alts = alts.slice(0, MAX_ALTS);
    switched = true;
  } else if (old && Array.isArray(old.alts) && old.alts.length) {
    fresh.alts = old.alts;
  }

  fresh.autoAt = Date.now();
  fresh.auto = true;
  map[host] = fresh;
  await saveMap(map);
  return { ok: true, host, snap: fresh, replaced: !!old, switched };
}

export const RESTORE_COOLDOWN = 10 * 60 * 1000;
const MAX_AUTO_RESTORE = 3;

// 判断「登录态是不是掉了」。
// 不能只看「当前像不像登录」—— 站点登出时往往只清 cookie，localStorage 里的
// token / userInfo 之类的键还留着，那样会被误判成「还登着」，永远不触发恢复。
// 所以拿快照里的登录 cookie 逐个对：少了一个就当掉了。
function sessionLost(snap, cur) {
  const authCookies = (snap.cookies || []).filter((c) => AUTH_HINT.test(c.name));
  if (authCookies.length) {
    const have = new Set((cur.cookies || []).map((c) => c.name));
    return authCookies.some((c) => !have.has(c.name));
  }
  // 快照里没有名字像会话的 cookie，退回比总分
  return authScore(cur) < authScore(snap);
}

// 自动恢复：这就是「保持登录状态」真正要的那一步。
// 页面加载完发现「有快照、但当前没登录了」就自己写回去。
// 必须防死循环：恢复会刷新页面，刷新又触发这里，所以有冷却时间和次数上限，
// 而且次数用完就不再试（避免快照本身已失效时反复刷新把页面卡死）。
export async function maybeAutoRestore(host, tabId) {
  if (!host) return { ok: false, skipped: 'no-host' };

  const map = await listSessions();
  const snap = map[host];
  if (!snap) return { ok: false, skipped: 'no-snapshot' };
  if (authScore(snap) === 0) return { ok: false, skipped: 'snapshot-not-auth' };

  const tries = snap.restoreTries || 0;
  if (tries >= MAX_AUTO_RESTORE) return { ok: false, skipped: 'gave-up' };
  if (Date.now() - (snap.restoredAt || 0) < RESTORE_COOLDOWN) {
    return { ok: false, skipped: 'cooldown' };
  }

  const cur = await snapshotSession(host, tabId, { dry: true });
  if (!cur.ok) return { ok: false, skipped: 'fail', error: cur.error };

  // 登录态还在，不用管
  if (!sessionLost(snap, cur.snap)) {
    // 一切正常，把重试次数清零，下次掉线又能自动救
    if (tries) {
      snap.restoreTries = 0;
      map[host] = snap;
      await saveMap(map);
    }
    return { ok: false, skipped: 'still-signed-in' };
  }

  snap.restoredAt = Date.now();
  snap.restoreTries = tries + 1;
  map[host] = snap;
  await saveMap(map);

  const r = await restoreSession(host, tabId);
  return { ...r, auto: true, tries: tries + 1 };
}

// 同一个站点可能存了多个账号：主份在 map[host]，其余的挂在 alts 里。
// who 为空就用主份。
function pickSnap(snap, who) {
  if (!snap) return null;
  if (!who) return snap;
  if (sameWho(snap.summary?.who, who)) return snap;
  for (const a of snap.alts || []) if (sameWho(a?.summary?.who, who)) return a;
  return null;
}

export async function restoreSession(host, tabId, who) {
  if (!host) return { ok: false, error: '拿不到站点域名' };
  const map = await listSessions();
  const root = map[host];
  if (!root) return { ok: false, error: '没有这个站点的快照' };

  let snap = pickSnap(root, who);
  if (!snap) return { ok: false, error: '这个站点下没有该账号的快照' };

  // 用户明确指定了某个账号：把它提成主份，原来的主份退到 alts，
  // 否则下次页面加载自动恢复时又会被主份盖回去
  if (who && snap !== root) {
    const rest = [root, ...(root.alts || [])].filter((x) => x !== snap);
    snap.alts = rest.slice(0, MAX_ALTS);
    snap.restoreTries = 0;
    snap.restoredAt = 0;
    map[host] = snap;
    await saveMap(map);
  }

  // cookie 不管当前在哪个页面都能先写
  const report = await writeCookies(snap, host);

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const curHost = tab?.url ? hostOf(tab.url) : '';

  if (!tab) {
    // 拿不到标签页：cookie 已经写进去了，但 storage 没法写。
    // 不能装作成功 —— 页面不刷新用户会以为没生效。
    return { ok: false, error: '拿不到标签页，storage 没写进去', partial: true, ...report };
  }

  if (curHost !== host) {
    // 不在这个站点上，storage 得等页面加载完再写，交给 resumePending
    await chrome.storage.local.set({ [PENDING_KEY]: { host, at: Date.now(), tabId, who: snap.summary?.who || '' } });
    // 跳转目标用快照里记的原 URL：https://host/ 会丢掉端口和路径，
    // 本地调试站点（带端口）和挂在子路径下的后台会被跳到错误的地方
    const target = snap.url || ('https://' + host + '/');
    await chrome.tabs.update(tabId, { url: target });
    return { ok: true, navigating: true, ...report };
  }

  const n = await writeStorage(tabId, snap);
  await chrome.tabs.reload(tabId);
  return { ok: true, reloading: true, storage: n, ...report };
}

// 跳转完成后把 storage 补上。写之前先清标记，否则刷新回来会再写一遍，死循环。
export async function resumePending(tabId, url) {
  const { [PENDING_KEY]: p } = await chrome.storage.local.get(PENDING_KEY);
  if (!p || p.tabId !== tabId) return false;
  if (Date.now() - (p.at || 0) > 120000) {
    await chrome.storage.local.remove(PENDING_KEY);
    return false;
  }
  if (hostOf(url) !== p.host) return false;

  await chrome.storage.local.remove(PENDING_KEY);
  const map = await listSessions();
  const snap = pickSnap(map[p.host], p.who);
  if (!snap) return false;

  await writeStorage(tabId, snap);
  await chrome.tabs.reload(tabId);
  return true;
}

export async function removeSession(host, who) {
  const map = await listSessions();
  const root = map[host];
  if (!root) return map;

  // 指定了账号就只删那一个，主份被删时把最新的替补提上来
  if (who && !sameWho(root.summary?.who, who)) {
    const alts = (root.alts || []).filter((a) => !sameWho(a?.summary?.who, who));
    if (alts.length) root.alts = alts;
    else delete root.alts;
    map[host] = root;
  } else if (who && Array.isArray(root.alts) && root.alts.length) {
    const next = root.alts[0];
    next.alts = root.alts.slice(1);
    if (!next.alts.length) delete next.alts;
    map[host] = next;
  } else {
    delete map[host];
  }

  await saveMap(map);
  return map;
}

export async function clearSessions() {
  await chrome.storage.local.set({ [SESSION_KEY]: {} });
  return {};
}

/* ---------------- 导入导出 ---------------- */

export async function exportSessions(hosts) {
  const map = await listSessions();
  const want = Array.isArray(hosts) && hosts.length ? new Set(hosts) : null;
  const out = {};
  for (const h of Object.keys(map)) {
    if (want && !want.has(h)) continue;
    out[h] = map[h];
  }
  return { version: 1, kind: 'session-snapshot', exportedAt: new Date().toISOString(), sessions: out };
}

export async function importSessions(payload, opts = {}) {
  const src = payload?.sessions || payload;
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { ok: false, error: '文件里没有会话数据' };
  }

  const map = opts.replace ? {} : await listSessions();
  let added = 0;
  let updated = 0;

  for (const h of Object.keys(src)) {
    const s = src[h];
    if (!s || typeof s !== 'object' || !Array.isArray(s.cookies)) continue;
    // 以 map 的键为准：快照里的 host 字段可能是手改过的旧值，
    // 用它会让两个不同站点互相覆盖
    const host = String(h || s.host).toLowerCase();
    if (!host) continue;
    if (map[host]) updated++; else added++;
    map[host] = { ...s, host };
  }

  await saveMap(map);
  return { ok: true, added, updated, total: Object.keys(map).length };
}
