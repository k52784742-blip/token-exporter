/**
 * 平台定义（背景页 / 弹窗 / 浮窗共用）
 *
 * mode = 'device'  : 走该平台自己的设备码授权接口
 * mode = 'capture' : 抓取模式，不需要知道接口
 *
 * 这里的内置平台只描述「接口形状」，不绑定具体服务。
 * 用户可以在设置页按同一形状接入自己的平台。
 */

export const DEVICE_PATH = {
  state: '/v2/plugin/auth/state',
  token: '/v2/plugin/auth/token',
  account: '/v2/plugin/login/account',
  refresh: '/v2/plugin/auth/token/refresh',
};

export const LOGIN_PENDING = 11217;

/**
 * 内置模板
 *
 * 这两个模板对应同一套设备码授权接口的两种区域端点。
 * 默认不预填任何真实域名 —— 需要用户在设置页里填自己的 host，
 * 或者直接从页面抓取（抓取模式不需要配置）。
 */
export const PRESETS = [
  {
    id: 'device-oauth-cn',
    label: '设备码授权 · 区域一',
    flag: '①',
    mode: 'device',
    hosts: [],
    origin: '',
    domain: '',
    markers: [],
    refreshSource: 'plugin',
    acceptLanguage: 'zh-CN',
  },
  {
    id: 'device-oauth-intl',
    label: '设备码授权 · 区域二',
    flag: '②',
    mode: 'device',
    hosts: [],
    origin: '',
    domain: '',
    markers: [],
    refreshSource: 'plugin',
    acceptLanguage: 'en-US',
  },
];

export function hostMatches(host, pattern) {
  if (!pattern) return false;
  const h = String(host).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return false;
}

export function detectPlatform(host, extra = []) {
  const all = PRESETS.concat(extra);
  return all.find((p) => (p.hosts || []).some((h) => hostMatches(host, h))) || null;
}

export function platformById(id, extra = []) {
  return PRESETS.concat(extra).find((p) => p.id === id) || null;
}
