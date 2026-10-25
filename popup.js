import { PRESETS, detectPlatform } from './platforms.js';
import {
  humanLeftLong, expiryLevel, maskToken, jwtIdentity, timeAgo,
  sortByUrgency, copyText, todayStamp, rowKey, escapeHtmlSafe, parseJwt,
} from './utils.js';

const $ = (id) => document.getElementById(id);


const state = {
  pool: [],
  captured: [],
  sessions: {},
  platforms: PRESETS.slice(),
  settings: {},
  stats: null,
  tab: null,
  activePlatform: null,
  tabView: 'pool',
  query: '',
  selected: new Set(),
  selectMode: false,
  sortMode: 'urgency',     // urgency | name | added
  filterStatus: 'all',     // all | expired | soon | disabled
  detailKey: null,
  sDetail: null,
};

const ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="4"/><path d="M12 12l7 7M16 16l2-2M19 19l2-2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
};


function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function sitePlatform(host) {
  return {
    id: 'site:' + host,
    label: host || '本页',
    flag: '🌐',
    mode: 'capture',
    hosts: [host],
    origin: host ? 'https://' + host : '',
    domain: host,
  };
}


async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;

  await refreshAll();

  const host = state.tab?.url ? safeHost(state.tab.url) : '';
  const custom = state.platforms.filter((p) => !PRESETS.some((x) => x.id === p.id));
  const known = detectPlatform(host, custom);

  // 上次选过的平台优先（但只在这个站点确实属于那个平台时才用）
  const savedId = state.settings.lastPlatform;
  const savedPlat = savedId ? state.platforms.find((p) => p.id === savedId) : null;
  state.activePlatform = savedPlat || known || sitePlatform(host);

  // 恢复上次的排序偏好
  if (state.settings.sortMode) state.sortMode = state.settings.sortMode;
  if (state.settings.filterStatus) state.filterStatus = state.settings.filterStatus;
  if (state.settings.exportFormat) {
    const f = $('export-format');
    if (f) f.value = state.settings.exportFormat;
  }
  if ($('filter-status')) $('filter-status').value = state.filterStatus || 'all';

  try {
    const v = chrome.runtime.getManifest().version;
    if ($('ver')) $('ver').textContent = 'v' + v;
  } catch (e) {}

  renderPlatforms();
  renderHeader();
  renderStats();
  renderList();
  loadSiteRule();

  $('btn-sort').textContent = { urgency: '按到期', name: '按名称', added: '按添加' }[state.sortMode] || '按到期';

  setStatus(known?.mode === 'device'
    ? '点「授权添加账号」开始'
    : '先登录目标站点，再点扫描');
}

async function refreshAll() {
  const res = await send({ type: 'get-state' });
  if (res?.ok) {
    state.pool = res.pool || [];
    state.captured = res.captured || [];
    state.platforms = res.platforms || PRESETS.slice();
    state.settings = res.settings || {};
  }
  const st = await send({ type: 'stats' });
  if (st?.ok) state.stats = st.stats;

  const se = await send({ type: 'session-list' });
  if (se?.ok) state.sessions = se.sessions || {};
}


function renderPlatforms() {
  const sel = $('platform');
  const host = state.tab?.url ? safeHost(state.tab.url) : '';

  const opts = state.platforms.map((p) => ({
    id: p.id,
    label: `${p.flag || '🌐'} ${p.label}`,
  }));

  const known = state.platforms.find((p) => (p.hosts || []).some((h) => h === host));
  if (!known) opts.push({ id: 'site:' + host, label: `🌐 本页抓取 · ${host}` });

  sel.innerHTML = opts.map((o) => (
    `<option value="${escapeHtmlSafe(o.id)}"${o.id === state.activePlatform.id ? ' selected' : ''}>${escapeHtmlSafe(o.label)}</option>`
  )).join('');
}

function renderHeader() {
  const p = state.activePlatform;
  const chip = $('site');
  const isDevice = p.mode === 'device';

  chip.className = 'site-chip ' + (isDevice ? 'mode-device' : 'mode-capture');
  chip.textContent = isDevice ? `${p.flag} ${p.label}` : (p.label || '本页');
  chip.title = p.label;

  const main = $('btn-main');
  main.innerHTML = isDevice
    ? ICON.plus + ' 授权添加账号'
    : ICON.scan + ' 扫描本页';

  $('hint').innerHTML = isDevice
    ? '走设备码授权流程，access 和 refresh 都能拿到。<br>明文存在本地，公用电脑记得清空。'
    : '只记录本页出现过的 token，不上传任何地方。<br>扫不到就刷新页面再点一次。';
}


function renderStats() {
  const el = $('stats');
  if (!el) return;
  const s = state.stats || { pool: 0, expired: 0, expiringSoon: 0, withRefresh: 0 };

  if (!s.pool) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';

  const parts = [`<span class="stat-item"><b>${s.pool}</b> 个凭证</span>`];
  if (s.expired) parts.push(`<span class="stat-item bad"><b>${s.expired}</b> 已过期</span>`);
  if (s.expiringSoon) parts.push(`<span class="stat-item warn"><b>${s.expiringSoon}</b> 即将到期</span>`);
  if (s.disabled) parts.push(`<span class="stat-item"><b>${s.disabled}</b> 已停用</span>`);
  if (s.withRefresh) parts.push(`<span class="stat-item"><b>${s.withRefresh}</b> 可续期</span>`);

  el.innerHTML = parts.join('<span class="stat-sep"></span>');
}


function renderCounts() {
  $('pool-count').textContent = state.pool.length;
  $('cap-count').textContent = state.captured.length;
  const sn = $('sess-count');
  if (sn) sn.textContent = Object.keys(state.sessions || {}).length;
  $('list-title').textContent = state.tabView === 'pool' ? '凭证池'
    : state.tabView === 'session' ? '会话快照'
    : '本页扫到的';

  // 会话页签用自己的一套底栏，别和凭证操作的按钮混在一起
  const isSess = state.tabView === 'session';
  const foot = document.querySelector('.foot');
  const sessFoot = $('sess-foot');
  if (foot) foot.hidden = isSess;
  if (sessFoot) sessFoot.hidden = !isSess;

  document.querySelectorAll('.seg').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === state.tabView);
  });
}

function renderList() {
  renderCounts();
  renderStats();
  if (state.tabView === 'captured') return renderCaptured();
  if (state.tabView === 'session') return renderSessions();
  return renderPool();
}

function emptyBox(text) {
  return `<div class="empty">${ICON.key}${text}</div>`;
}

function filterRows(rows) {
  const q = state.query.trim().toLowerCase();
  const st = state.filterStatus;

  let out = rows;
  if (st === 'expired') out = out.filter((r) => r.expiresAt && r.expiresAt <= Date.now() && r.enabled !== false);
  else if (st === 'soon') out = out.filter((r) => {
    if (!r.expiresAt || r.enabled === false) return false;
    const left = r.expiresAt - Date.now();
    return left > 0 && left < 3 * 86400000;
  });
  else if (st === 'disabled') out = out.filter((r) => r.enabled === false);

  if (!q) return out;
  return out.filter((r) => {
    const hay = [
      r.nickname, r.uid, r.domain, r.platform, r.note,
      r.auth_raw?.account?.uin,
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** 把命中的关键词包成 mark，搜索时能一眼看到为什么匹配 */
function highlight(text) {
  const s = String(text == null ? '' : text);
  const q = state.query.trim();
  if (!q) return escapeHtmlSafe(s);
  const lower = s.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return escapeHtmlSafe(s);
  return escapeHtmlSafe(s.slice(0, idx))
    + '<mark>' + escapeHtmlSafe(s.slice(idx, idx + q.length)) + '</mark>'
    + escapeHtmlSafe(s.slice(idx + q.length));
}

function renderPool() {
  const el = $('list');
  const now = Date.now();

  if (!state.pool.length) {
    el.innerHTML = emptyBox('凭证池是空的<br>授权添加，或者从当前页面扫一个');
    updateBulkBar();
    return;
  }

  let rows = filterRows(state.pool);
  if (state.sortMode === 'urgency') rows = sortByUrgency(rows, now);
  else if (state.sortMode === 'name') rows = rows.slice().sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || ''), 'zh'));
  else rows = rows.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  if (!rows.length) {
    el.innerHTML = `<div class="empty">没找到匹配「${escapeHtmlSafe(state.query)}」的凭证</div>`;
    updateBulkBar();
    return;
  }

  el.innerHTML = rows.map((row) => {
    const key = rowKey(row);
    const p = state.platforms.find((x) => x.id === row.platform);
    const left = (row.expiresAt || 0) - now;
    const lv = expiryLevel(row.expiresAt, now);

    let avCls = 'site';
    if (row.platform === 'device-oauth-cn') avCls = 'cn';
    else if (row.platform === 'device-oauth-intl') avCls = 'intl';

    const initial = (row.nickname || row.uid || '?').slice(0, 1).toUpperCase();
    const name = row.nickname || (row.uid ? row.uid.slice(0, 10) : '(未命名)');
    const sub = row.note ? ('【' + row.note + '】') : (row.domain || row.uid || '');
    const checked = state.selected.has(key);
    const canRefresh = !!row.refresh_token;

    const pillCls = lv === 'expired' ? 'bad' : (lv === 'urgent' || lv === 'warning') ? 'warn' : 'ok';
    const pillText = row.expiresAt ? humanLeftLong(left) : '到期未知';

    return `
      <div class="item${checked ? ' selected' : ''}${row.enabled === false ? ' disabled' : ''}" data-key="${escapeHtmlSafe(key)}">
        ${state.selectMode
          ? `<span class="checkbox${checked ? ' on' : ''}">${checked ? ICON.check : ''}</span>`
          : `<div class="avatar ${avCls}">${escapeHtmlSafe(initial)}</div>`}
        <div class="meta">
          <div class="name">${highlight(name)}</div>
          <div class="sub">${highlight(String(sub).slice(0, 30))}</div>
        </div>
        ${canRefresh ? '<span class="dot-refresh" title="可续期"></span>' : ''}
        <span class="pill ${pillCls}">${escapeHtmlSafe(pillText)}</span>
        ${state.selectMode ? '' : `<button class="detail-btn" data-detail="${escapeHtmlSafe(key)}" title="详情">${ICON.chevron}</button>`}
      </div>`;
  }).join('');

  el.querySelectorAll('[data-detail]').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); openDetail(b.dataset.detail); });
  });
  el.querySelectorAll('.item').forEach((it) => {
    it.addEventListener('click', () => {
      if (state.selectMode) toggleSelect(it.dataset.key);
      else openDetail(it.dataset.key);
    });
  });

  updateBulkBar();
}

function renderCaptured() {
  const el = $('list');
  const now = Date.now();

  if (!state.captured.length) {
    el.innerHTML = emptyBox('还没扫到 token<br>先登录，刷新页面，再点扫描');
    return;
  }

  const rows = state.captured.slice().reverse();

  el.innerHTML = `
    <div class="captured-head">
      <span>共 ${rows.length} 个</span>
      <button class="btn tiny primary" id="btn-add-all">全部加入</button>
    </div>`
    + rows.map((c) => {
    const id = jwtIdentity(c.token);
    const label = c.kind.startsWith('body:') ? c.kind.slice(5)
      : c.kind.startsWith('localStorage:') ? 'localStorage'
      : c.kind.startsWith('cookie:') ? 'cookie'
      : c.kind;
    const who = id.name || id.email || id.sub || '';
    const exp = id.exp ? (id.exp * 1000 - now) : 0;
    const expText = id.exp ? humanLeftLong(exp) : '';

    return `
      <div class="item">
        <div class="avatar cap">T</div>
        <div class="meta">
          <div class="name">${escapeHtmlSafe(label)}</div>
          <div class="sub">${escapeHtmlSafe(who.slice(0, 24) || c.host || '')}${expText ? ' · ' + escapeHtmlSafe(expText) : ''}</div>
        </div>
        <span class="src-tag">${escapeHtmlSafe(timeAgo(c.at, now))}</span>
        <button class="btn small" data-add="${escapeHtmlSafe(c.key)}">加入</button>
      </div>`;
  }).join('');

  el.querySelectorAll('[data-add]').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); addCaptured(b.dataset.add); });
  });

  const addAll = el.querySelector('#btn-add-all');
  if (addAll) {
    addAll.addEventListener('click', async () => {
      addAll.disabled = true;
      addAll.textContent = '加入中…';
      const r = await send({ type: 'add-captured-many' });
      if (r?.ok) {
        await refreshAll();
        state.tabView = 'pool';
        renderList();
        setStatus(`已加入 ${r.added} 个`, 'ok');
      } else {
        addAll.disabled = false;
        addAll.textContent = '全部加入';
        setStatus('加入失败：' + (r?.error || '未知'), 'err');
      }
    });
  }
}


function renderSessions() {
  const el = $('list');
  const now = Date.now();
  const map = state.sessions || {};
  const cur = state.tab?.url ? safeHost(state.tab.url) : '';

  // 会话页签也吃搜索框：站点域名和账号名都能搜
  const q = state.query.trim().toLowerCase();
  const allHosts = Object.keys(map).sort((a, b) => (map[b]?.at || 0) - (map[a]?.at || 0));
  const hosts = q
    ? allHosts.filter((h) => {
      if (h.toLowerCase().includes(q)) return true;
      const root = map[h] || {};
      return [root, ...(root.alts || [])].some((s) =>
        String(s.summary?.who || '').toLowerCase().includes(q));
    })
    : allHosts;

  if (!allHosts.length) {
    el.innerHTML = emptyBox('还没有会话快照<br>登录好一个站点，切到「会话」再点「存本站」');
    return;
  }
  if (!hosts.length) {
    el.innerHTML = emptyBox('没有匹配的站点');
    return;
  }

  el.innerHTML = `
    <div class="captured-head">
      <span>共 ${allHosts.length} 个站点${q ? ` · 匹配 ${hosts.length}` : ''}</span>
      <span class="sess-tip">快照含 cookie 与 storage</span>
    </div>`
    + hosts.map((h) => {
    const root = map[h] || {};
    // 一个站点可能存了几个账号，主份 + alts 一起铺出来，各占一行
    const rows = [root, ...(root.alts || [])];
    return rows.map((s, idx) => {
      const sm = s.summary || {};
      const isCur = h === cur;
      const isAlt = idx > 0;
      const who = sm.who || '';
      const bits = [];
      if (sm.cookies) bits.push(`${sm.cookies} cookie`);
      if (sm.httpOnly) bits.push(`${sm.httpOnly} HttpOnly`);
      if (sm.local) bits.push(`${sm.local} 本地项`);
      if (sm.session) bits.push(`${sm.session} 会话项`);
      // 自动恢复试满 3 次还是没成，说明快照本身过期了，得让用户知道别再等
      if ((s.restoreTries || 0) >= 3) bits.push('已失效，需重新登录后存一份');

      const w = escapeHtmlSafe(who);
      return `
      <div class="item sess${isCur && !isAlt ? ' current' : ''}${isAlt ? ' alt' : ''}" data-host="${escapeHtmlSafe(h)}">
        <div class="avatar sess${sm.authLike ? ' auth' : ''}">${sm.authLike ? '✓' : '·'}</div>
        <div class="meta">
          <div class="name">${highlight(h)}${isCur && !isAlt ? ' <span class="cur-tag">当前</span>' : ''}${who ? ` <span class="who-tag">${w}</span>` : ''}</div>
          <div class="sub">${escapeHtmlSafe(bits.join(' · ') || '空快照')}</div>
        </div>
        <span class="src-tag">${escapeHtmlSafe(timeAgo(s.at, now))}</span>
        <button class="btn small" data-srestore="${escapeHtmlSafe(h)}" data-who="${w}">恢复</button>
        <button class="icon-mini" data-sdel="${escapeHtmlSafe(h)}" data-who="${w}" title="删除">${ICON.x}</button>
      </div>`;
    }).join('');
  }).join('');

  // 顺手告诉用户自动保存有没有开着，不然会以为没生效
  const hint = el.querySelector('.sess-tip');
  if (hint && state.settings?.autoSnapshot === false) {
    hint.textContent = '自动保存已关 · 只能手动存';
    hint.style.color = 'var(--warn, #f59e0b)';
  }

  el.querySelectorAll('[data-srestore]').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); restoreSessionByHost(b.dataset.srestore, b.dataset.who); });
  });
  el.querySelectorAll('[data-sdel]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const h = b.dataset.sdel;
      const who = b.dataset.who || '';
      const label = who ? `${h} 的 ${who}` : h;
      if (!confirm(`删除 ${label} 的会话快照？`)) return;
      const r = await send({ type: 'session-remove', host: h, who });
      if (r?.ok) {
        state.sessions = r.sessions || {};
        renderList();
        setStatus('已删除', 'ok');
      }
    });
  });
  el.querySelectorAll('.item').forEach((it) => {
    it.addEventListener('click', (ev) => {
      // 行内按钮已经各自处理过，别再叠一次
      if (ev.target.closest('button')) return;
      const btn = it.querySelector('[data-srestore]');
      openSessionDetail(it.dataset.host, btn?.dataset.who || '');
    });
  });
}


function toggleSelect(key) {  if (state.selected.has(key)) state.selected.delete(key);
  else state.selected.add(key);
  renderList();
}

function updateBulkBar() {
  const bar = $('bulkbar');
  if (!bar) return;
  const n = state.selected.size;

  if (!state.selectMode) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('bulk-count').textContent = n ? `已选 ${n} 个` : '点选凭证';

  const all = state.pool.length > 0 && state.selected.size === state.pool.length;
  $('bulk-all').textContent = all ? '取消全选' : '全选';
}


async function openDetail(key) {
  const res = await send({ type: 'reveal', key });
  if (!res?.ok) return setStatus('读取失败：' + (res?.error || '未知'), 'err');

  const row = res.row;
  state.detailKey = key;

  const id = jwtIdentity(row.access_token);
  const now = Date.now();
  const left = (row.expiresAt || 0) - now;
  const rleft = (row.refreshExpiresAt || 0) - now;
  const platform = state.platforms.find((p) => p.id === row.platform);

  $('detail-title').textContent = row.nickname || (row.uid ? row.uid.slice(0, 12) : '凭证详情');

  $('detail-body').innerHTML = `
    <div class="drow"><span class="dk">平台</span><span class="dv">${escapeHtmlSafe(platform ? `${platform.flag} ${platform.label}` : row.platform || '—')}</span></div>
    <div class="drow"><span class="dk">域名</span><span class="dv mono">${escapeHtmlSafe(row.domain || '—')}</span></div>
    <div class="drow">
      <span class="dk">UID</span>
      <span class="dv mono">${escapeHtmlSafe(row.uid || '—')}</span>
      ${row.uid ? '<button class="copy-mini" data-copy-field="uid" title="复制 UID">复制</button>' : ''}
    </div>
    ${row.auth_raw?.account?.uin ? `<div class="drow">
      <span class="dk">UIN</span>
      <span class="dv mono">${escapeHtmlSafe(row.auth_raw.account.uin)}</span>
      <button class="copy-mini" data-copy-field="uin" title="复制 UIN">复制</button>
    </div>` : ''}
    <div class="drow"><span class="dk">access</span><span class="dv ${expiryLevel(row.expiresAt, now) === 'expired' ? 'bad' : ''}">${row.expiresAt ? humanLeftLong(left) : '到期未知'}</span></div>
    <div class="drow"><span class="dk">refresh</span><span class="dv ${rleft <= 0 && row.refreshExpiresAt ? 'bad' : ''}">${row.refreshExpiresAt ? (row.refresh_token ? humanLeftLong(rleft) : '无') : '无'}</span></div>
    ${row.note ? `<div class="drow"><span class="dk">备注</span><span class="dv">${escapeHtmlSafe(row.note)}</span></div>` : ''}
    ${id.scopes.length ? `<div class="drow"><span class="dk">scope</span><span class="dv mono small">${escapeHtmlSafe(id.scopes.join(' '))}</span></div>` : ''}
    ${row.lastRefreshAt ? `<div class="drow"><span class="dk">上次续期</span><span class="dv">${escapeHtmlSafe(timeAgo(row.lastRefreshAt, now))}</span></div>` : ''}
    <div class="drow col">
      <span class="dk">access_token</span>
      <code class="tok">${escapeHtmlSafe(maskToken(row.access_token))}</code>
      <button class="copy-mini block" data-copy-field="access_token">复制完整 access_token</button>
    </div>
    ${row.refresh_token ? `<div class="drow col">
      <span class="dk">refresh_token</span>
      <code class="tok">${escapeHtmlSafe(maskToken(row.refresh_token))}</code>
      <button class="copy-mini block" data-copy-field="refresh_token">复制完整 refresh_token</button>
    </div>` : ''}
    <div class="drow" id="detail-check-row">
      <span class="dk">状态</span>
      <span class="dv" id="detail-check-result">—</span>
    </div>
  `;

  // 详情里各字段的复制按钮
  $('detail-body').querySelectorAll('[data-copy-field]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const f = btn.dataset.copyField;
      let val = '';
      if (f === 'uid') val = row.uid || '';
      else if (f === 'uin') val = row.auth_raw?.account?.uin || '';
      else val = row[f] || '';
      if (!val) return;
      const ok = await copyText(val);
      setStatus(ok ? `已复制 ${f}` : '复制失败', ok ? 'ok' : 'err');
    });
  });

  $('detail').hidden = false;

  // 从体检模式切回来时，把单条操作按钮恢复
  $('detail-copy-token').style.display = '';
  $('detail-remove').style.display = '';
  $('detail-refresh-one').style.display = row.refresh_token ? '' : 'none';
  $('detail-toggle').textContent = row.enabled === false ? '启用' : '停用';

  // 打开即自动检一次（设备模式走服务端，抓取模式看本地时间）
  $('detail-check-result').textContent = '检查中…';
  send({ type: 'check', key }).then((r) => {
    const el = $('detail-check-result');
    if (!el) return;
    if (!r?.ok) { el.textContent = r?.error || '检查失败'; el.className = 'dv bad'; return; }
    el.textContent = r.detail + (r.method === 'local' ? '' : '');
    el.className = 'dv' + (r.alive ? '' : ' bad');
  });
}

function closeDetail() {
  $('detail').hidden = true;
  state.detailKey = null;
}

/** 会话详情：点行进来先看清里面有什么，再决定恢复还是删 */
function openSessionDetail(host, who) {
  const root = (state.sessions || {})[host];
  if (!root) return;
  const rows = [root, ...(root.alts || [])];
  const snap = who ? rows.find((s) => (s.summary?.who || '') === who) : root;
  if (!snap) return;

  state.sDetail = { host, who: snap.summary?.who || '' };
  const sm = snap.summary || {};
  const now = Date.now();

  const cookies = Array.isArray(snap.cookies) ? snap.cookies : [];
  const local = snap.storage?.local || {};
  const session = snap.storage?.session || {};
  const names = Object.keys(local);

  $('sdetail-title').textContent = host + (sm.who ? ` · ${sm.who}` : '');

  $('sdetail-body').innerHTML = `
    <div class="drow"><span class="dk">站点</span><span class="dv mono">${escapeHtmlSafe(host)}</span></div>
    ${sm.who ? `<div class="drow"><span class="dk">账号</span><span class="dv">${escapeHtmlSafe(sm.who)}</span></div>` : ''}
    <div class="drow"><span class="dk">存于</span><span class="dv">${escapeHtmlSafe(timeAgo(snap.at, now))}${snap.auto ? ' · 自动' : ''}</span></div>
    <div class="drow"><span class="dk">体积</span><span class="dv">${escapeHtmlSafe(bytesText(snap.bytes || 0))}</span></div>
    ${snap.restoredAt ? `<div class="drow"><span class="dk">上次恢复</span><span class="dv">${escapeHtmlSafe(timeAgo(snap.restoredAt, now))}${snap.restoreTries ? ` · 试了 ${snap.restoreTries} 次` : ''}</span></div>` : ''}
    ${(snap.restoreTries || 0) >= 3 ? '<div class="drow"><span class="dk"></span><span class="dv bad">这份快照已经失效了，重新登录后存一份新的</span></div>' : ''}

    <div class="drow col">
      <span class="dk">cookie · ${cookies.length}</span>
      ${cookies.length ? `<div class="chip-list">${cookies.slice(0, 40).map((c) => {
    const tag = c.httpOnly ? ' <i class="mini-tag">HttpOnly</i>' : '';
    return `<span class="chip">${escapeHtmlSafe(c.name)}${tag}</span>`;
  }).join('')}${cookies.length > 40 ? `<span class="chip">…还有 ${cookies.length - 40} 个</span>` : ''}</div>`
      : '<span class="dv dim">无</span>'}
    </div>

    <div class="drow col">
      <span class="dk">localStorage · ${names.length}</span>
      ${names.length ? `<div class="chip-list">${names.slice(0, 40).map((k) =>
    `<span class="chip">${escapeHtmlSafe(k)}</span>`).join('')}${names.length > 40 ? `<span class="chip">…还有 ${names.length - 40} 个</span>` : ''}</div>`
      : '<span class="dv dim">无</span>'}
    </div>

    ${Object.keys(session).length ? `<div class="drow col">
      <span class="dk">sessionStorage · ${Object.keys(session).length}</span>
      <div class="chip-list">${Object.keys(session).slice(0, 40).map((k) => `<span class="chip">${escapeHtmlSafe(k)}</span>`).join('')}</div>
    </div>` : ''}
  `;

  $('sdetail').hidden = false;
}

function closeSessionDetail() {
  $('sdetail').hidden = true;
  state.sDetail = null;
}

function bytesText(n) {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}


let statusTimer = null;

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');

  if (statusTimer) clearTimeout(statusTimer);
  if (kind === 'ok' || kind === 'err') {
    statusTimer = setTimeout(() => {
      el.className = 'status';
      el.textContent = '就绪';
    }, 4000);
  }
}


async function addCaptured(key) {
  const r = await send({ type: 'add-captured', key });
  if (r?.ok) {
    await refreshAll();
    state.tabView = 'pool';
    renderList();
    setStatus('已加入凭证池', 'ok');
  } else {
    setStatus('加入失败：' + (r?.error || '未知'), 'err');
  }
}

async function doScan() {
  const host = state.tab?.url ? safeHost(state.tab.url) : '';
  setStatus('扫描中…');

  if (state.tab?.id) {
    chrome.tabs.sendMessage(state.tab.id, { type: 'rescan-page' }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 700));

  const r = await send({ type: 'scan', host });
  if (r?.ok) {
    state.captured = r.captured || [];
    state.tabView = 'captured';
    renderList();

    const mine = state.captured.filter((c) => !c.host || c.host === host);
    if (mine.length) setStatus(`扫到 ${mine.length} 个 · 点「加入」收进池子`, 'ok');
    else setStatus('没扫到。刷新页面后立刻再扫一次', 'err');
  } else {
    setStatus('扫描失败：' + (r?.error || '未知'), 'err');
  }
}

async function doMainAction() {
  if (state.activePlatform.mode === 'device') return doAuth();
  return doScan();
}

async function doAuth() {
  const btn = $('btn-main');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '等待登录…';
  setStatus('正在申请授权码…');

  const r = await send({ type: 'authorize', platformId: state.activePlatform.id });
  if (!r?.ok) {
    btn.disabled = false;
    btn.innerHTML = orig;
    return setStatus('' + (r?.error || '申请失败'), 'err');
  }

  try {
    await chrome.tabs.create({ url: r.authUrl });
  } catch (e) {
    setStatus('请手动打开：' + r.authUrl, 'err');
  }
  setStatus('已打开登录页 · 请完成扫码');

  const deadline = Date.now() + 5 * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2000));
    tick++;
    const p = await send({ type: 'poll-now', platformId: state.activePlatform.id, state: r.state });
    if (p?.status === 'ok') {
      btn.disabled = false;
      btn.innerHTML = orig;
      await refreshAll();
      renderList();
      return setStatus('已添加：' + (p.row?.nickname || '账号'), 'ok');
    }
    if (p?.status === 'error') {
      btn.disabled = false;
      btn.innerHTML = orig;
      return setStatus('' + (p.message || '授权失败'), 'err');
    }
    setStatus(`等待登录中… ${tick * 2}s`);
  }
  btn.disabled = false;
  btn.innerHTML = orig;
  setStatus('等待超时，请重试', 'err');
}

async function doCopy() {
  const rows = state.selectMode && state.selected.size
    ? state.pool.filter((r) => state.selected.has(rowKey(r)))
    : state.pool;

  if (!rows.length) return setStatus('没有可复制的凭证', 'err');

  const allWb = rows.every((r) => r.auth_raw);
  const data = rows.map((r) => allWb ? {
    access_token: r.access_token, refresh_token: r.refresh_token, uid: r.uid,
    nickname: r.nickname, domain: r.domain, expiresAt: r.expiresAt,
    refreshExpiresAt: r.refreshExpiresAt, auth_raw: r.auth_raw,
  } : {
    platform: r.platform, domain: r.domain, access_token: r.access_token,
    refresh_token: r.refresh_token, uid: r.uid, nickname: r.nickname,
    expiresAt: r.expiresAt, refreshExpiresAt: r.refreshExpiresAt,
    source: r.source, claims: r.claims,
  });

  const ok = await copyText(JSON.stringify(data, null, 2));
  setStatus(ok ? `已复制 ${rows.length} 条` : '复制失败，请用「下载」', ok ? 'ok' : 'err');
}

async function doDownload() {
  const onlyValid = $('opt-only-valid')?.checked;
  const format = $('export-format')?.value || 'auto';

  // 批量模式下只导选中的
  const useSelection = state.selectMode && state.selected.size > 0;
  const payload = { type: 'export', onlyValid, format };
  if (useSelection) payload.keys = [...state.selected];

  const r = await send(payload);
  if (!r?.ok) return setStatus('导出失败：' + (r?.error || '未知'), 'err');

  // postman 是单个对象，其余是数组
  const empty = Array.isArray(r.rows) ? !r.rows.length : !r.rows;
  if (empty) return setStatus('没有可导出的凭证', 'err');

  // 纯文本格式不包 JSON
  const isPlain = ['raw', 'bearer', 'curl', 'env'].includes(r.format);
  const text = isPlain ? r.rows.join('\n\n') : JSON.stringify(r.rows, null, 2);

  const extMap = { curl: 'sh', env: 'env', raw: 'txt', bearer: 'txt', postman: 'postman_collection.json' };
  const ext = extMap[r.format] || 'json';

  const host = state.tab?.url ? safeHost(state.tab.url) : 'tokens';
  const name = r.format === 'device'
    ? `accounts-${todayStamp()}.${ext}`
    : `tokens-${host}-${todayStamp()}.${ext}`;

  const blob = new Blob([text], { type: isPlain ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  const skipped = r.skipped || 0;
  const cnt = r.count ?? (Array.isArray(r.rows) ? r.rows.length : 0);
  const scope = useSelection ? '（选中）' : '';
  setStatus(`已下载 ${cnt} 条${scope} · ${r.format}${skipped ? ` · 跳过 ${skipped}` : ''}`, 'ok');
}

async function doClear() {
  if (!state.pool.length && !state.captured.length) return setStatus('本来就是空的');
  const msg = `确定清空？\n\n凭证池：${state.pool.length} 条\n扫到的：${state.captured.length} 条\n\n已下载的文件不受影响。`;
  if (!confirm(msg)) return;

  await send({ type: 'clear-pool' });
  await send({ type: 'clear-captured' });
  await refreshAll();
  renderList();
  setStatus('已清空', 'ok');
}

async function doRefresh() {
  if (!state.pool.length) return setStatus('凭证池是空的', 'err');
  const btn = $('btn-refresh');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '续期中';

  const r = await send({ type: 'refresh-all', force: false });
  btn.disabled = false;
  btn.innerHTML = orig;

  if (r?.ok) {
    await refreshAll();
    renderList();
    if (!r.total) return setStatus('都还新鲜，不需要续期');
    if (r.fails?.length) {
      setStatus(`续期：成功 ${r.okCount}，失败 ${r.fails.length} · ${String(r.fails[0]).slice(0, 60)}`, 'err');
    } else {
      setStatus(`续期完成：${r.okCount} 个已更新`, 'ok');
    }
  } else {
    setStatus('续期失败：' + (r?.error || '未知'), 'err');
  }
}

/* ---- 批量操作 ---- */

async function bulkRemove() {
  if (!state.selected.size) return;
  if (!confirm(`确定移除选中的 ${state.selected.size} 个凭证？`)) return;
  const r = await send({ type: 'remove-many', keys: [...state.selected] });
  if (r?.ok) {
    state.selected.clear();
    state.selectMode = false;
    await refreshAll();
    renderList();
    setStatus(`已移除 ${r.removed} 个`, 'ok');
  }
}

async function bulkCopy() {
  await doCopy();
}

/** 读当前站点的钩子开关状态 */
async function loadSiteRule() {
  const host = state.tab?.url ? safeHost(state.tab.url) : '';
  if (!host) return;
  const r = await send({ type: 'get-site-rule', host });
  const on = r?.ok ? r.hook !== false : true;
  state.siteHook = on;
  const btn = $('btn-site-toggle');
  if (btn) {
    btn.textContent = on ? '本站已开' : '本站已关';
    btn.classList.toggle('off', !on);
  }
}

/** 切换当前站点的钩子 */
async function toggleSiteRule() {
  const host = state.tab?.url ? safeHost(state.tab.url) : '';
  if (!host) return;

  const next = !(state.siteHook !== false);
  const r = await send({ type: 'set-site-rule', host, hook: next });
  if (!r?.ok) return setStatus('切换失败', 'err');

  state.siteHook = next;
  const btn = $('btn-site-toggle');
  if (btn) {
    btn.textContent = next ? '本站已开' : '本站已关';
    btn.classList.toggle('off', !next);
  }

  if (next) {
    setStatus('已开启 · 刷新页面后生效', 'ok');
  } else {
    setStatus('已关闭 · 刷新页面后彻底停用', 'ok');
  }
}

async function bulkRefresh() {
  if (!state.selected.size) return setStatus('先选几个', 'err');
  const btn = $('bulk-refresh');
  btn.disabled = true;

  const keys = [...state.selected];
  let ok = 0;
  const fails = [];

  for (let i = 0; i < keys.length; i++) {
    btn.textContent = `${i + 1}/${keys.length}`;
    setStatus(`续期中 ${i + 1}/${keys.length}…`);
    const r = await send({ type: 'refresh-one', key: keys[i] });
    if (r?.ok) ok++; else fails.push(r?.reason || '失败');
  }

  btn.disabled = false;
  btn.textContent = '续期';
  await refreshAll();
  renderList();
  setStatus(`续期 ${ok} 个${fails.length ? `，${fails.length} 个失败` : ''}`, fails.length ? 'err' : 'ok');
}

async function bulkToggle() {
  if (!state.selected.size) return setStatus('先选几个', 'err');

  const rows = state.pool.filter((r) => state.selected.has(rowKey(r)));
  const anyEnabled = rows.some((r) => r.enabled !== false);
  const target = !anyEnabled;   // 有一个是启用状态就全停用，否则全启用

  for (const r of rows) {
    await send({ type: 'toggle-enabled', key: rowKey(r), enabled: target });
  }
  await refreshAll();
  renderList();
  setStatus(target ? `已启用 ${rows.length} 个` : `已停用 ${rows.length} 个`, 'ok');
}

async function doBackup() {
  const r = await send({ type: 'backup' });
  if (!r?.ok) return setStatus('备份失败', 'err');

  const text = JSON.stringify(r.data, null, 2);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `token-backup-${todayStamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(`已备份 ${r.data.accounts.length} 个凭证`, 'ok');
}

function doRestore() {
  $('restore-file').click();
}

async function onRestoreFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  ev.target.value = '';

  if (file.size > 5 * 1024 * 1024) return setStatus('文件太大（上限 5MB）', 'err');

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const r = await send({ type: 'restore', data });
    if (!r?.ok) return setStatus('恢复失败：' + (r?.error || '未知'), 'err');
    await refreshAll();
    renderList();
    setStatus(`恢复完成：新增 ${r.added}，更新 ${r.updated}`, 'ok');
  } catch (e) {
    setStatus('文件解析失败：' + e.message, 'err');
  }
}

async function removeExpired() {
  const st = state.stats;
  if (!st?.expired) return setStatus('没有已过期的凭证');
  if (!confirm(`确定移除 ${st.expired} 个已过期的凭证？`)) return;
  const r = await send({ type: 'remove-expired' });
  if (r?.ok) {
    await refreshAll();
    renderList();
    setStatus(`已清理 ${r.removed} 个过期凭证`, 'ok');
  }
}

/** 清掉过期的 + 压根不像 token 的脏数据 */
async function cleanGarbage() {
  if (!state.pool.length) return setStatus('凭证池是空的', 'err');
  if (!confirm('清掉已过期的，和不像 token 的条目？\n\n建议先点「备份」再清。')) return;

  const r = await send({ type: 'clean-garbage' });
  if (!r?.ok) return setStatus('清理失败：' + (r?.error || '未知'), 'err');

  await refreshAll();
  renderList();

  if (!r.removed) return setStatus('没有需要清理的', 'ok');
  const sample = (r.dropped || []).slice(0, 3)
    .map((x) => `${x.name}（${x.reason}）`).join('、');
  setStatus(`已清理 ${r.removed} 个${sample ? '：' + sample : ''}`, 'ok');
}

/** 整池体检：能打服务端的打一遍，抓来的只看本地时间 */
async function checkAll() {
  if (!state.pool.length) return setStatus('凭证池是空的', 'err');

  const btn = $('btn-check-all');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '体检中';
  setStatus('正在体检…');

  const r = await send({ type: 'check-all' });
  btn.disabled = false;
  btn.textContent = orig;

  if (!r?.ok) return setStatus('体检失败：' + (r?.error || '未知'), 'err');

  state.healthResult = r;
  renderHealth(r);

  const unk = r.unknown || 0;
  if (r.dead) {
    setStatus(`体检完成：${r.alive} 个有效，${r.dead} 个失效${unk ? `，${unk} 个无法判断` : ''}`, 'err');
  } else {
    setStatus(`体检完成：${r.alive} 个全部有效${unk ? `，${unk} 个无法判断` : ''}`, 'ok');
  }
}

/** 把体检结果画进详情类型的小抽屉 */
function renderHealth(r) {
  const dead = (r.results || []).filter((x) => !x.alive);
  const alive = (r.results || []).filter((x) => x.alive);

  const unknown = r.unknown || 0;
  $('detail-title').textContent = unknown
    ? `体检结果 · ${r.alive} 有效 / ${r.dead} 失效 / ${unknown} 无法判断`
    : `体检结果 · ${r.alive} 有效 / ${r.dead} 失效`;

  const methodLabel = (m) => (m === 'remote' ? '服务端' : m === 'unknown' ? '无到期时间' : '本地');

  const row = (x) => `
    <div class="drow">
      <span class="dk">${x.alive ? '有效' : '失效'}</span>
      <span class="dv${x.alive ? '' : ' bad'}">
        ${escapeHtmlSafe(x.name)}<br>
        <span class="dv small">${escapeHtmlSafe(x.detail)} · ${methodLabel(x.method)}</span>
      </span>
    </div>`;

  $('detail-body').innerHTML =
    (dead.length ? `<div class="health-head bad">失效 ${dead.length}</div>${dead.map(row).join('')}` : '')
    + (alive.length ? `<div class="health-head ok">有效 ${alive.length}</div>${alive.map(row).join('')}` : '');

  $('detail').hidden = false;
  state.detailKey = null;
  // 体检模式下隐藏「复制 token / 移除」这两个针对单条的按钮
  $('detail-copy-token').style.display = 'none';
  $('detail-remove').style.display = 'none';
}


function openImport(mode) {
  const isManual = mode === 'manual';
  $('modal-title').textContent = isManual ? '手动加 token' : '粘贴导入';
  $('modal-desc').textContent = isManual
    ? '粘贴 access_token。换行后可再贴 refresh_token。'
    : '支持完整导出数组、单个对象、或只贴 token。字段名 access_token / accessToken / 嵌套 auth_raw 都能识别。';
  $('modal-input').placeholder = isManual
    ? 'eyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs...'
    : '[\n  {\n    "access_token": "eyJ...",\n    "refresh_token": "eyJ...",\n    "uid": "..."\n  }\n]';
  $('modal-input').value = '';
  $('modal').hidden = false;
  $('modal-input').focus();
}

async function confirmImport() {
  const text = $('modal-input').value.trim();
  if (!text) { $('modal').hidden = true; return; }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const lines = text.split(/[\s,]+/).filter(Boolean);
    if (lines.length >= 1 && lines[0].startsWith('eyJ')) {
      parsed = [{ access_token: lines[0], refresh_token: lines[1] || '' }];
    } else {
      alert('解析失败：既不是 JSON，也不是以 eyJ 开头的 token');
      return;
    }
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];

  // 先预览：会新增几个、覆盖几个、哪些解析不了
  const pv = await send({
    type: 'preview-import',
    rows: items,
    platformId: state.activePlatform.mode === 'device' ? state.activePlatform.id : null,
  });

  if (!pv?.ok) return setStatus('预览失败：' + (pv?.error || '未知'), 'err');

  const lines = [`共 ${pv.total} 条`];
  if (pv.added.length) lines.push(`新增 ${pv.added.length}`);
  if (pv.updated.length) lines.push(`覆盖 ${pv.updated.length}`);
  if (pv.invalid.length) lines.push(`无法解析 ${pv.invalid.length}`);

  const detail = [];
  if (pv.updated.length) detail.push('覆盖：' + pv.updated.slice(0, 5).join('、') + (pv.updated.length > 5 ? '…' : ''));
  if (pv.invalid.length) detail.push('失败：' + pv.invalid.slice(0, 3).map((x) => `${x.name}（${x.reason}）`).join('；'));

  const okToGo = confirm(lines.join('，') + '\n\n' + detail.join('\n') + '\n\n继续导入？');
  if (!okToGo) return;

  let ok = 0;
  const errors = [];
  for (const item of items) {
    const r = await send({
      type: 'add-token',
      row: item,
      platformId: state.activePlatform.mode === 'device' ? state.activePlatform.id : null,
    });
    if (r?.ok) ok++; else errors.push(r?.error || '失败');
  }

  $('modal').hidden = true;
  await refreshAll();
  state.tabView = 'pool';
  renderList();

  if (errors.length) setStatus(`导入 ${ok} 条，${errors.length} 条失败：${errors[0]}`, 'err');
  else setStatus(`导入 ${ok} 条`, 'ok');
}


/* ---------------- 会话快照 ---------------- */

async function saveSessionHere() {
  const btn = $('btn-sess-save');
  const host = state.tab?.url ? safeHost(state.tab.url) : '';
  if (!host) return setStatus('当前页面拿不到域名', 'err');

  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '保存中…';

  const r = await send({ type: 'session-snapshot', tabId: state.tab.id, host });

  btn.disabled = false;
  btn.textContent = old;

  if (!r?.ok) return setStatus('保存失败：' + (r?.error || '未知'), 'err');

  state.sessions = (await send({ type: 'session-list' }))?.sessions || state.sessions;
  renderList();

  const s = r.snap?.summary || {};
  const bits = [`${s.cookies || 0} cookie`];
  if (s.httpOnly) bits.push(`${s.httpOnly} HttpOnly`);
  if (s.local) bits.push(`${s.local} 本地项`);
  if (s.session) bits.push(`${s.session} 会话项`);
  setStatus(`${host} 已保存 · ${bits.join(' · ')}`, 'ok');
}

async function restoreSessionByHost(host, who) {
  const target = host || (state.tab?.url ? safeHost(state.tab.url) : '');
  if (!target) return setStatus('当前页面拿不到域名', 'err');
  if (!state.sessions[target]) return setStatus(`${target} 还没有快照`, 'err');

  const same = state.tab?.url && safeHost(state.tab.url) === target;
  const name = who ? ` ${who} 的` : '';
  const tip = same
    ? `用${name}快照覆盖 ${target} 当前的登录态？页面会刷新一次。`
    : `${target} 不在当前标签页，会跳过去再恢复${who ? ' ' + who : ''}。继续？`;
  if (!confirm(tip)) return;

  const btn = $('btn-sess-restore');
  if (btn) { btn.disabled = true; btn.textContent = '恢复中…'; }

  const r = await send({ type: 'session-restore', tabId: state.tab.id, host: target, who: who || '' });

  if (btn) { btn.disabled = false; btn.textContent = '恢复本站'; }

  if (!r?.ok) return setStatus('恢复失败：' + (r?.error || '未知'), 'err');

  const bits = [`${r.cookies || 0} cookie`];
  if (r.storage) bits.push(`${r.storage} 项 storage`);
  if (r.cookieFailed?.length) bits.push(`${r.cookieFailed.length} 条被拒`);

  setStatus(`${target} 已写回 · ${bits.join(' · ')}，页面正在刷新`, 'ok');
  // 刷新会关掉 popup，不用等
}

async function exportSessions() {
  const r = await send({ type: 'session-export' });
  if (!r?.ok) return setStatus('导出失败', 'err');

  const n = Object.keys(r.data?.sessions || {}).length;
  if (!n) return setStatus('没有会话快照可导出', 'err');

  const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sessions-${todayStamp()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  setStatus(`已导出 ${n} 个站点的会话`, 'ok');
}

async function onSessionFile(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return setStatus('文件太大（上限 8MB）', 'err');

  try {
    const data = JSON.parse(await file.text());
    const r = await send({ type: 'session-import', data });
    if (!r?.ok) return setStatus('导入失败：' + (r?.error || '未知'), 'err');

    state.sessions = (await send({ type: 'session-list' }))?.sessions || {};
    renderList();
    setStatus(`已导入：新增 ${r.added}，更新 ${r.updated}`, 'ok');
  } catch (e) {
    setStatus('文件不是合法 JSON：' + e.message, 'err');
  }
}


function bind() {  $('platform').addEventListener('change', (e) => {
    const id = e.target.value;
    state.activePlatform = state.platforms.find((p) => p.id === id)
      || sitePlatform(state.tab?.url ? safeHost(state.tab.url) : '');
    send({ type: 'save-settings', settings: { lastPlatform: id } });
    renderHeader();
    renderList();
  });

  $('btn-main').addEventListener('click', doMainAction);
  $('btn-scan').addEventListener('click', doScan);
  $('btn-import').addEventListener('click', () => openImport('paste'));
  $('btn-manual').addEventListener('click', () => openImport('manual'));
  $('btn-copy').addEventListener('click', doCopy);
  $('btn-download').addEventListener('click', doDownload);
  $('btn-refresh').addEventListener('click', doRefresh);
  $('btn-clear').addEventListener('click', doClear);
  $('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // 状态筛选
  $('filter-status').addEventListener('change', (e) => {
    state.filterStatus = e.target.value;
    send({ type: 'save-settings', settings: { filterStatus: state.filterStatus } });
    renderList();
  });

  // 导出格式记忆
  $('export-format').addEventListener('change', (e) => {
    send({ type: 'save-settings', settings: { exportFormat: e.target.value } });
  });

  // 搜索
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; state.query = ''; renderList(); }
  });

  // 排序
  $('btn-sort').addEventListener('click', () => {
    const order = ['urgency', 'name', 'added'];
    const label = { urgency: '按到期', name: '按名称', added: '按添加' };
    const i = order.indexOf(state.sortMode);
    state.sortMode = order[(i + 1) % order.length];
    $('btn-sort').textContent = label[state.sortMode];
    send({ type: 'save-settings', settings: { sortMode: state.sortMode } });
    renderList();
  });

  // 批量
  $('btn-bulk').addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    $('btn-bulk').classList.toggle('active', state.selectMode);
    renderList();
  });

  $('bulk-all').addEventListener('click', () => {
    const visible = filterRows(state.pool);
    if (state.selected.size === visible.length) state.selected.clear();
    else visible.forEach((r) => state.selected.add(rowKey(r)));
    renderList();
  });

  $('bulk-remove').addEventListener('click', bulkRemove);
  $('bulk-copy').addEventListener('click', bulkCopy);
  $('bulk-refresh').addEventListener('click', bulkRefresh);
  $('bulk-toggle').addEventListener('click', bulkToggle);

  $('btn-backup').addEventListener('click', doBackup);
  $('btn-restore').addEventListener('click', doRestore);
  $('restore-file').addEventListener('change', onRestoreFile);

  // 详情
  $('detail-close').addEventListener('click', closeDetail);  $('detail').addEventListener('click', (e) => {
    if (e.target.id === 'detail') closeDetail();
  });
  $('detail-copy-token').addEventListener('click', async () => {
    if (!state.detailKey) return;
    const res = await send({ type: 'reveal', key: state.detailKey });
    if (!res?.ok) return;
    const ok = await copyText(res.row.access_token);
    setStatus(ok ? 'access_token 已复制' : '复制失败', ok ? 'ok' : 'err');
  });

  $('detail-refresh-one').addEventListener('click', async () => {
    if (!state.detailKey) return;
    const btn = $('detail-refresh-one');
    btn.disabled = true;
    btn.textContent = '续期中';
    const r = await send({ type: 'refresh-one', key: state.detailKey });
    btn.disabled = false;
    btn.textContent = '续期';
    if (r?.ok) {
      await refreshAll();
      closeDetail();
      setStatus('续期成功', 'ok');
    } else {
      setStatus('续期失败：' + (r?.reason || '未知'), 'err');
    }
  });

  $('detail-note').addEventListener('click', async () => {
    if (!state.detailKey) return;
    const res = await send({ type: 'reveal', key: state.detailKey });
    if (!res?.ok) return;
    const cur = res.row.note || '';
    const note = prompt('给这个凭证加个备注（留空清除）：', cur);
    if (note === null) return;
    await send({ type: 'add-note', key: state.detailKey, note });
    await refreshAll();
    closeDetail();
    setStatus(note ? '备注已保存' : '备注已清除', 'ok');
  });

  $('detail-toggle').addEventListener('click', async () => {
    if (!state.detailKey) return;
    const res = await send({ type: 'reveal', key: state.detailKey });
    if (!res?.ok) return;
    const next = res.row.enabled === false;
    const r = await send({ type: 'toggle-enabled', key: state.detailKey, enabled: next });
    if (r?.ok) {
      await refreshAll();
      closeDetail();
      setStatus(next ? '已启用' : '已停用', 'ok');
    }
  });

  $('detail-remove').addEventListener('click', async () => {
    if (!state.detailKey) return;
    if (!confirm('确定移除这个凭证？')) return;
    const r = await send({ type: 'remove', key: state.detailKey });
    if (r?.ok) {
      closeDetail();
      await refreshAll();
      renderList();
      setStatus('已移除', 'ok');
    }
  });

  // 清理过期
  $('btn-clean-expired').addEventListener('click', removeExpired);
  $('btn-clean-garbage').addEventListener('click', cleanGarbage);
  $('btn-check-all').addEventListener('click', checkAll);
  $('btn-site-toggle').addEventListener('click', toggleSiteRule);

  // 会话快照
  $('btn-sess-save').addEventListener('click', saveSessionHere);
  $('btn-sess-restore').addEventListener('click', () => restoreSessionByHost(''));
  $('btn-sess-export').addEventListener('click', exportSessions);
  $('btn-sess-import').addEventListener('click', () => $('sess-file').click());
  $('sess-file').addEventListener('change', onSessionFile);

  // 会话详情
  $('sdetail-close').addEventListener('click', closeSessionDetail);
  $('sdetail').addEventListener('click', (e) => {
    if (e.target.id === 'sdetail') closeSessionDetail();
  });
  $('sdetail-restore').addEventListener('click', () => {
    if (!state.sDetail) return;
    const { host, who } = state.sDetail;
    closeSessionDetail();
    restoreSessionByHost(host, who);
  });
  $('sdetail-remove').addEventListener('click', async () => {
    if (!state.sDetail) return;
    const { host, who } = state.sDetail;
    const label = who ? `${host} 的 ${who}` : host;
    if (!confirm(`删除 ${label} 的会话快照？`)) return;
    const r = await send({ type: 'session-remove', host, who });
    if (r?.ok) {
      state.sessions = r.sessions || {};
      closeSessionDetail();
      renderList();
      setStatus('已删除', 'ok');
    }
  });

  // 弹窗
  $('modal-cancel').addEventListener('click', () => { $('modal').hidden = true; });
  $('modal-ok').addEventListener('click', confirmImport);
  $('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') $('modal').hidden = true;
  });

  // 拖拽导入：把 JSON 文件拖到面板上
  const wrap = document.querySelector('.wrap');
  let dragDepth = 0;

  wrap.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    wrap.classList.add('dragging');
  });
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; wrap.classList.remove('dragging'); }
  });
  wrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    wrap.classList.remove('dragging');

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setStatus('文件太大（上限 2MB）', 'err');

    try {
      const text = await file.text();
      $('modal-input').value = text;
      $('modal-title').textContent = '拖入的文件';
      $('modal-desc').textContent = file.name;
      $('modal').hidden = false;
      $('modal-ok').focus();
    } catch (err) {
      setStatus('读取文件失败：' + err.message, 'err');
    }
  });

  // 标签
  document.querySelectorAll('.seg').forEach((t) => {
    t.addEventListener('click', () => {
      state.tabView = t.dataset.tab;
      renderList();
    });
  });

  // 键盘
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('modal').hidden) { $('modal').hidden = true; return; }
      if (!$('detail').hidden) { closeDetail(); return; }
      if (state.selectMode) {
        state.selectMode = false;
        state.selected.clear();
        $('btn-bulk').classList.remove('active');
        renderList();
      }
    }
    // Ctrl/Cmd + F 聚焦搜索
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'pool-changed') refreshAll().then(renderList);
  });
}

bind();
init();

