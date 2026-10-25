import { todayStamp, toDeviceExport, toGenericExport } from './utils.js';

const $ = (id) => document.getElementById(id);

async function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));
}

async function load() {
  const { settings_v1: settings = {}, accounts_v1: pool = [], custom_platforms_v1: custom = [] } =
    await chrome.storage.local.get(['settings_v1', 'accounts_v1', 'custom_platforms_v1']);

  $('opt-panel').checked = !!settings.showFloatingPanel;
  $('opt-autorefresh').checked = settings.autoRefresh !== false;
  $('count').textContent = (pool || []).length;
  $('custom-json').value = custom && custom.length ? JSON.stringify(custom, null, 2) : '';

  // 抓取范围
  $('opt-capture-all').checked = settings.captureAll !== false;
  $('allow-hosts').value = Array.isArray(settings.allowHosts) ? settings.allowHosts.join('\n') : '';
  $('allow-hosts').disabled = settings.captureAll !== false;

  // 版本号从 manifest 读，省得两处对不上
  try {
    const v = chrome.runtime.getManifest().version;
    if ($('ver')) $('ver').textContent = v;
  } catch (e) {}

  renderSiteRules();
}

/* 站点例外 */

async function renderSiteRules() {
  const res = await send({ type: 'list-site-rules' });
  const rules = res?.ok ? (res.rules || {}) : {};
  const hosts = Object.keys(rules).filter((h) => rules[h] && rules[h].hook === false);

  const el = $('site-list');
  if (!el) return;

  el.innerHTML = hosts.map((h) => `
    <div class="site-row" data-host="${h.replace(/"/g, '&quot;')}">
      <span class="site-host">${h.replace(/</g, '&lt;')}</span>
      <button class="site-off" data-open="${h.replace(/"/g, '&quot;')}">启用</button>
    </div>`).join('');

  el.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', async () => {
      await send({ type: 'set-site-rule', host: b.dataset.open, hook: null });
      await renderSiteRules();
      msg('site-msg', '已重新启用', true);
    });
  });
}

function msg(id, text, ok) {
  const el = $(id);
  if (!el) return;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

$('btn-site-off').addEventListener('click', async () => {
  const host = ($('site-host').value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  if (!host) return msg('site-msg', '填个域名，比如 example.com', false);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return msg('site-msg', '域名格式不对', false);

  await send({ type: 'set-site-rule', host, hook: false });
  $('site-host').value = '';
  await renderSiteRules();
  msg('site-msg', `已关掉 ${host}，刷新它的页面生效`, true);
});

$('opt-panel').addEventListener('change', async (e) => {
  await send({ type: 'save-settings', settings: { showFloatingPanel: e.target.checked } });
});

$('opt-autorefresh').addEventListener('change', async (e) => {
  await send({ type: 'save-settings', settings: { autoRefresh: e.target.checked } });
});

/* 抓取范围（白名单） */

$('opt-capture-all').addEventListener('change', async (e) => {
  const all = e.target.checked;
  $('allow-hosts').disabled = all;
  await send({ type: 'save-settings', settings: { captureAll: all } });

  if (all) {
    msg('allow-msg', '已改为所有站点都抓', true);
  } else {
    const n = ($('allow-hosts').value || '').split(/[\n,]/).filter((s) => s.trim()).length;
    msg('allow-msg', n ? `已改为只抓白名单里的 ${n} 个站点` : '白名单是空的，这样哪儿都不会抓 —— 先填几个域名', !n);
  }
});

$('allow-hosts').addEventListener('change', async (e) => {
  const list = e.target.value
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);

  await send({ type: 'save-settings', settings: { allowHosts: list } });

  if (!list.length) {
    msg('allow-msg', '列表是空的。白名单模式下这样哪儿都不抓', false);
  } else if ($('opt-capture-all').checked) {
    msg('allow-msg', `已保存 ${list.length} 个站点（当前是全站模式，白名单暂不生效）`, true);
  } else {
    msg('allow-msg', `已保存 ${list.length} 个站点`, true);
  }
});

$('btn-export').addEventListener('click', async () => {
  const { accounts_v1: pool = [] } = await chrome.storage.local.get('accounts_v1');
  if (!pool.length) return;
  const allWb = pool.every((r) => r.auth_raw);
  const rows = allWb ? pool.map(toDeviceExport) : pool.map(toGenericExport);
  const text = JSON.stringify(rows, null, 2);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = allWb
    ? `accounts-${todayStamp()}.json`
    : `tokens-${todayStamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('btn-wipe').addEventListener('click', async () => {
  const { accounts_v1: pool = [] } = await chrome.storage.local.get('accounts_v1');
  if (!pool.length) return;
  if (!confirm(`确定清空 ${pool.length} 条凭证？已下载的文件不受影响。`)) return;
  await send({ type: 'clear-pool' });
  load();
});

$('btn-save-custom').addEventListener('click', async () => {
  const msg = $('custom-msg');
  const text = $('custom-json').value.trim();
  msg.className = 'msg';
  msg.textContent = '';

  if (!text) {
    await chrome.storage.local.set({ custom_platforms_v1: [] });
    msg.className = 'msg ok';
    msg.textContent = '已清空自定义平台';
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = 'JSON 解析失败：' + e.message;
    return;
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const p of list) {
    if (!p || !p.id || !p.mode || !p.origin) {
      msg.className = 'msg err';
      msg.textContent = '每条必须有 id / mode / origin';
      return;
    }
  }

  await chrome.storage.local.set({ custom_platforms_v1: list });
  msg.className = 'msg ok';
  msg.textContent = `已保存 ${list.length} 个自定义平台`;
});

$('btn-reset-custom').addEventListener('click', async () => {
  await chrome.storage.local.set({ custom_platforms_v1: [] });
  $('custom-json').value = '';
  const msg = $('custom-msg');
  msg.className = 'msg ok';
  msg.textContent = '已恢复内置平台';
});

load();
