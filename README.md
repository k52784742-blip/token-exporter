# 通用凭证导出器

Chrome / Edge 扩展。干一件事：把网页上的登录凭证（token / cookie）导出来。

作者 **Faynt**。非商业使用免费，禁止商用倒卖，详见 [LICENSE](LICENSE)。

---

## 怎么来的

浏览器里想拿登录凭证，一般两条路：

- Cookie-Editor 那种工具 —— 只能导 cookie，token 拿不到
- 手动 F12 翻 Network —— 每次都得找请求、复制 header

麻烦的是，很多 OAuth 类站点的 token 压根不存浏览器里。它只活在页面 JS 的内存变量里，
或者干脆只有桌面客户端才有。

这个扩展两种路子都走：

- **授权模式** —— 走平台自己的设备码授权，主动换一份 token。得知道接口长什么样。
- **抓取模式** —— 钩住页面的 `fetch` / `XHR`，请求发生时顺手截下来。不用知道接口。

---

## 三种用法

### 抓 token（开箱即用）

任意站点都能用，不需要配置。钩住页面的网络请求，把出现过的 token 截下来。

### 存登录态（开箱即用）

token 和「保持登录」是两件事。站点认的是 cookie，所以这里能整包存下 cookie（含
HttpOnly 那些 JS 拿不到的）和 localStorage / sessionStorage，之后一键写回去。

详见下面的 [登录态](#登录态)。

### 设备码授权（需要配置）

如果你的目标站点走的是设备码授权，可以主动换一份 token。接口形状是：

```
POST /v2/plugin/auth/state?platform=CLI   →  state + authUrl
       ↓  打开 authUrl 扫码
GET  /v2/plugin/auth/token?state=xxx      →  accessToken + refreshToken
GET  /v2/plugin/login/account             →  uid / nickname / uin
```

内置两个模板对应这套接口的两种区域端点，**域名是空的，需要你在设置页自己填**。
填好 host 和 origin 之后，这个站点就会被识别成设备授权模式。

导出的 JSON 含 `auth_raw` 那层嵌套（外层毫秒、内层秒），和走这套接口的桌面客户端一致。

接口形状不一样的平台，得改 `background.js` 里的适配 —— 见下面「加平台」。

---

## 装

```
git clone <this-repo>
```

1. `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 右上角打开开发者模式
3. 加载已解压的扩展程序，选这个文件夹
4. 工具栏出现钥匙图标

想确认没坏，跑一下：

```
npm run lint
```

会把 manifest、语法、引用、按钮绑定、消息路由全查一遍。

---

## 抓取模式怎么用

**这一条很关键**：token 只在请求发生的那一刻存在。打开页面后什么都没干就点扫描，
十有八九是空的。

正确顺序：

1. 打开目标站点，正常登录
2. 刷新页面，等它加载完（页面自己会发请求）
3. 点扩展图标 →「扫描本页」
4. 切到「扫到」那个标签 → 点「加入」

还是空的话，在页面上随便点点、翻个页，再扫一次。

扫到多个时可以点「全部加入」一次收进池子。

### 只在你指定的站点跑

默认所有站点都会注入钩子。如果不想这样，设置页关掉「所有站点都抓」，
然后填白名单：

```
www.example.com
app.example.com
```

白名单模式下，其他站点完全不注入，页面行为跟没装扩展一样。
子域名会跟着父域名走（`sub.example.com` 匹配 `example.com`）。

### 能抓到什么

| 来源 | 说明 |
|---|---|
| 响应体 | 递归找 JSON 里的 token 字段，7 层深 |
| 请求头 | `Authorization`、带 token 字样的头 |
| URL 参数 | `?access_token=xxx` 这种 OAuth 回调 |
| 存储 | localStorage、sessionStorage、IndexedDB |
| cookie | 含 HttpOnly（走 `chrome.cookies`） |
| WebSocket | 握手 URL 和消息帧 |
| sendBeacon | 页面关闭时的上报 |

几个容易踩的坑已经处理了：

- **不是 JWT 的 token** 也能抓。字段名明确叫 `accessToken` 时，32 位以内的随机串照收
- **XHR `responseType` 是 json 或 blob** 时不会因为读 `responseText` 报错而漏掉
- **SSE 流式响应** 会被识别并跳过，不会卡在 `.text()` 上
- 抓到东西时页面左下角会弹个小提示，不用打开面板也知道成了

---

## 导出

八种格式，看你要干嘛：

| 格式 | 出来是什么 |
|---|---|
| 自动 | 全是设备授权账号就走原生格式，否则通用 JSON |
| 设备授权 | 原生那 8 个字段 |
| 通用 JSON | 带 claims 解码的完整信息 |
| 纯 token | 一行一个 access_token |
| Bearer | 一行一个 `Bearer xxx`，直接粘 header |
| curl | 能直接跑的命令 |
| .env | `XXX_TOKEN=...`，喂给程序 |
| Postman | 导入即用的 collection |

可以勾「跳过过期」，只导还能用的。批量模式下只导选中的那些，停用的凭证默认不参与导出。

---

## 登录态

token 只是凭证，站点认的是 cookie。想真正「保持登录」，得整包存下来。

弹窗里第三个页签是 **会话**：

- **存本站** —— 把当前站点的 cookie（含 HttpOnly）和 localStorage / sessionStorage 整包存下来
- **恢复** —— 写回去然后刷新页面。不在这个站点上会先跳过去再写
- **导出 / 导入** —— 一份 JSON，能挪到别的机器

默认开启两个自动行为（设置页可关）：

- **自动保存** —— 页面加载完顺手存一份。5 分钟内的重复访问不会重写。单页应用登录完不刷新页面的，靠盯登录接口的响应头补上
- **自动恢复** —— 打开站点发现没登录了，就用快照写回去

两个自动行为都有防护，不是无脑覆盖：

**登出不会毁掉快照。** 站点登出时 cookie 被清空，这时候如果照常存，等于把能救命的快照亲手删了。所以新状态比旧状态更不像登录态时，一律不写。

**恢复不会死循环。** 恢复要刷新页面，刷新又触发检查。同一站点 10 分钟内只试一次，连续 3 次没成功就停手 —— 快照本身过期了的话，反复刷新只会把页面卡死。列表里会标「已失效，需重新登录后存一份」。

判断「掉登录了」不能只看 localStorage 里还有没有 token。真实站点登出时通常只清 cookie，`userInfo`、`theme` 这些键还留着，那样会被误判成还登着。所以是拿快照里的登录 cookie 逐个对，少一个就当掉了。

### 一个站点多个账号

同一站点换号登录，旧快照不会被顶掉 —— 会被收进这个站点的「备选」里，列表里显示成两行，各自带账号名。

- 账号名优先取站点自己的 cookie（`nick` / `username` 这类），其次看 localStorage 里的 `uid` / `nickname` / `email`
- 恢复和删除都是按账号来的：点哪一行就恢复哪个账号，不会串
- 每个站点最多留 5 个备选，超出按时间淘汰最旧的

这个判断是猜的，不是站点告诉我们的。少数站点 cookie 里什么都没有、localStorage 又是加密的，那就认不出来 —— 这时列表里只显示域名，两行看起来一样，只能靠时间来区分。

---

## 续期

access_token 剩不到 1 天会自动续，12 小时最多一次。也能手动点。

上游每次续期都会换新的 refresh_token，旧的立刻作废。所以续期必须串行跑 —— 并发的话
第二个请求会拿着已经失效的 token 去换，直接把号换废。这点代码里做了限制。

续完记得重新下载，磁盘上的旧文件不会自己更新。

---

## 管理

- **停用 / 启用** —— 不删凭证，只是让它不参与导出和续期。列表里会变灰
- **备注** —— 给凭证加一句话说明，能搜到
- **批量** —— 多选后可以批量复制、续期、停用、移除
- **备份 / 恢复** —— 全量导出成 JSON（含设置、自定义平台、站点例外），恢复时按 uid 合并，不会覆盖掉现有的
- **体检** —— 一次查完整个池子，按失效 / 有效分组

---

## 界面

- **统计条** —— 总数 / 过期 / 即将到期 / 已停用 / 可续期
- **搜索** —— 昵称、UID、域名、备注实时过滤，命中的字会高亮，`Ctrl/Cmd + F` 聚焦
- **状态筛选** —— 全部 / 已过期 / 即将到期 / 已停用
- **排序** —— 按到期 / 名称 / 添加，选过会记住
- **详情** —— 点一行展开，含 JWT 声明、脱敏 token、实时有效性检查；UID、UIN、两个 token 都能单独复制
- **批量** —— 多选后批量复制、续期、停用或移除
- **拖拽导入** —— JSON 文件直接拖到面板上
- **图标角标** —— 有快过期的显示数量，过期的标红
- **快捷键** —— `Alt+Shift+T` 打开面板
- **右键菜单** —— 页面上右键可以扫描本页
- 浮窗可选，默认关

### 有效性检查

打开详情会自动查一次。设备授权的账号是真的打一次接口确认，抓来的凭证没有统一校验口子，
只能看本地到期时间。

底部「体检」按钮可以一次把整个池子过一遍，结果按失效 / 有效分组。

### 导入

三种方式：粘贴、手动贴 token、把 JSON 文件拖到面板上。

粘贴之后会先给一份预览，告诉你这次会新增几个、覆盖几个、哪几条解析不了，确认了才真写进去。
明显不是凭证的东西会被挡住 —— 太短、带空格、是网址，都会单独报原因。

---
---

## 加平台

改 `platforms.js` 里的 `PRESETS`，或者在设置页填 JSON：

```json
[{
  "id": "my-platform",
  "label": "某平台",
  "flag": "🌐",
  "mode": "device",
  "hosts": ["www.example.com"],
  "origin": "https://www.example.com",
  "domain": "www.example.com",
  "refreshSource": "plugin",
  "acceptLanguage": "en-US"
}]
```

前提是那个平台的接口路径也是 `/v2/plugin/auth/state` 这一套。形状不一样的话，
得改 `background.js` 里的适配。

---

## 一些实现上的事

### 抓取为什么要拆成两个脚本

Chrome 扩展的 content script 默认在隔离世界跑。那里的 `window.fetch` 是隔离世界的，
钩不到页面自己的 fetch。

所以拆开：

```
page-hook.js   (world: "MAIN")   钩页面 fetch/XHR
      ↓ MessageChannel
bridge.js      (ISOLATED)        转发给 background
      ↓
background.js                    落盘 + 去重
```

### 为什么 token 要走 MessageChannel

早先版本用 `window.postMessage` 传，`targetOrigin` 还是 `'*'`。postMessage 是广播 ——
页面上任何脚本，包括目标站自己的、广告、被注入的第三方，都能监听 message 事件把
token 读走。

现在改成点对点的 MessageChannel。握手消息不带凭证，token 全程不进 window 的事件。

### 抓到的 token 为什么要落盘

MV3 的 service worker 空闲 30 秒左右就会被杀。内存变量说没就没，所以直接写
`chrome.storage.local`。

### 反检测做了哪些

网站查 `fetch` 有没有被改，是最常见的反调试手法。这里处理了：

| 检测点 | 处理 |
|---|---|
| `fetch.toString()` | 返回 `function fetch() { [native code] }` |
| `Function.prototype.toString.call(fetch)` | 同上 |
| `fetch.length` | 对齐成 1 |
| `fetch.name` | `fetch` |
| `Object.getOwnPropertyNames(fetch)` | 只剩 `length` / `name` |
| `fetch.hasOwnProperty('prototype')` | 箭头函数包装，天生没有 |
| `fetch.hasOwnProperty('toString')` | 改成继承 |
| XHR 三个方法 | 逐个伪装 |
| `for...in` 扫全局 | 守卫用 Symbol，扫不到 |
| 页面找固定 id | 注入的 DOM id 随机化 |
| WebSocket / sendBeacon | 同样伪装 |

实测 11 项全过，而且伪装后 `fetch` / `XHR` 照常工作。

做不到的：

- **完整性校验** —— 有的站会算脚本哈希，本地改不了
- **服务端风控** —— 看的是请求特征，本地怎么伪装都没用
- **`debugger` 死循环** —— 会让页面卡死
- **专门探测扩展资源** 的站

### 站点例外

有些站点的风控特别敏感，钩子会让页面出问题。设置页可以单独关掉某个域名：

- 关掉后刷新，钩子会还原成原生函数并退出
- 只影响那个域名
- 代价是那个站抓不到东西了

弹窗和浮窗底部也有「本站已开」的快捷开关。

---

## 权限

| 权限 | 干什么用的 |
|---|---|
| `storage` | 存凭证、扫到的东西、会话快照、设置 |
| `cookies` | 读写 cookie —— 读是为了找 token，写是为了恢复登录态 |
| `webRequest` | 读请求头里的 Authorization；盯登录接口的 Set-Cookie 判断刚登录 |
| `tabs` | 查当前标签、打开授权页、恢复快照时跳转和刷新 |
| `clipboardWrite` | 复制导出结果 |
| `alarms` | 定时续期，以及页面跳转后补写 storage |
| `scripting` | 页面没有内容脚本时兜底读写 storage |
| `<all_urls>` | 任意站点可用 |

数据全在本地，没有任何上传。`background.js` 里所有 `fetch` 只发往你配置的平台域名。

只在自己固定的几个站点用的话，可以把 `host_permissions` 收窄：

```json
"host_permissions": [
  "https://your-site-a.com/*",
  "https://your-site-b.com/*"
]
```

`content_scripts` 里的 `matches` 也要一起改。

---

## 目录结构

```
.
├── manifest.json       MV3 清单
├── background.js       Service worker：webRequest / cookies / 授权 / 续期 / 存储
├── page-hook.js        MAIN world：钩页面 fetch/XHR
├── bridge.js           隔离世界：转发 + 补扫 cookie + 抓到提示
├── panel.js            页面浮窗
├── session.js          会话快照：cookie + storage 的存与取
├── platforms.js        平台定义
├── utils.js            JWT 解析、格式组装
├── popup.html/css/js   弹窗
├── options.html/css/js 设置页
├── icons/
└── scripts/check.js    自检
```

---

## 关于安全

- 凭证**明文**存在 `chrome.storage.local`。公用电脑上用完记得清空。
- 清空 = 彻底删掉，refresh_token 也没了，只能重新授权。
- 导出的 JSON 别乱发，里面是完整的登录凭证。
- 这个工具是给自己导自己账号用的。

---

## 已知限制

- 抓取依赖请求发生，纯内存里、从不发出去的 token 抓不到
- 授权模式只支持接口形状和内置模板一致的平台
- 浮窗会稍微影响页面加载（默认关）
- 会话快照最多存 80 个站点，单个上限 3 MB，超了不存（会提示体积）
- 恢复登录态对「服务端主动作废旧会话」的站点无效 —— 快照里的 cookie 服务端已经不认了，这种情况只能重新登录
- 快照里已经过期的 cookie 写回时会降级成会话 cookie（浏览器关掉就没了），否则 Chrome 直接拒收，恢复会悄无声息地失败
- 账号名是从 cookie 和 localStorage 里猜的，认不出来就只显示域名
- 密码本身不会被存，快照里只有服务端发下来的会话凭证
- Firefox 没测过，`world: "MAIN"` 需要 128 以上

---

Faynt · [非商业许可](LICENSE)
