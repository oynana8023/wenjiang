# 文匠 AI · 二创工作台

把一条链接，写成你的稿。移动端优先的静态 Web App，零后端依赖。`index.html` 是单文件自包含产物，可以直接部署到 GitHub Pages、添加到主屏幕当 App 用，也可以双击本地打开。

## 现在有什么

**真实数据，不造假**
- 热榜覆盖 10 个公开源：微博、知乎、头条、百度、抖音、B站、36氪、IT之家、极客公园、少数派。抓取走官方接口（微博带 Referer、知乎走 `api.zhihu.com`、抖音走热榜 API、36氪走网关 POST），每条都带 `实时` 或 `快照` 标签和抓取时间。
- 抓不到就显示抓不到，不会用编造内容填充。
- 时政、军事、外交类条目不进入榜单（不适合二创），页面上会写明过滤了多少条。
- 站内 12 篇示例素材一律标注 `示例素材 · 非真实新闻`，详情页顶部有黄条警告。

**链接解析怎么才能成功**

浏览器受同源策略限制，读不了别人的网页；「贴链接取正文」必须有一台服务器代抓。所以解析能力 = 你手上有多少条服务端通道。现在有三层：

1. **同源服务**：页面本身由 `node server.js` 托管时，零跨域，最快。
2. **自建 / 云端服务（主力）**：`worker/index.js` 是 Cloudflare Worker 版，一键部署后就是**永久属于你自己的解析地址**（免费额度每天 10 万次）。「我的 → 解析服务」可以填多个地址，解析时**并行竞速**，谁先返回合格正文用谁，某一条挂了不影响其他。默认预置了一个跑在沙箱里的云端实例 `https://ae4456e3164821b38.app.workbuddy.host`，它是临时环境，**建议换成自己的 Worker**。
3. **公共代理**：只剩 3 条，能通的越来越少，仅作兜底。

「我的 → 解析服务 → 保存并检测」会把每条通道的在线状态和延迟列出来：绿色 `在线 · xx ms` 说明这条能用，红色会写明为什么连不上。

实测 2026-11-19：公众号（mp.weixin.qq.com）4239 字 / 2182 字、IT之家 310 字、少数派 1129 字、极客公园 5939 字，均能取到正文；36氪、知乎、微博搜索页取不到（前两个是 JS 渲染 + 风控，微博热搜给的是搜索页而不是文章）。

### 三分钟上线自己的解析服务

1. 打开 <https://deploy.workers.cloudflare.com/?url=https://github.com/oynana8023/wenjiang/tree/main/worker>
2. 用 GitHub / 邮箱登录 Cloudflare（免费，不需要信用卡）→ 点 **Deploy**
3. 拿到 `https://wenjiang-parse.xxx.workers.dev`，打开 App →「我的 → 解析服务」→ 粘进去 → **保存并检测**

想在改代码后自动重新部署，就往仓库 Secrets 里加 `CF_API_TOKEN` 和 `CF_ACCOUNT_ID`，`.github/workflows/deploy-worker.yml` 会在 `worker/` 有改动时自动发布。细节见 `worker/README.md`。

**链路**
1. 找选题：首页/热榜页点一条，弹出这一条的原文链接，可以一键打开、一键复制、一键解析正文；榜单只给搜索页的源（微博/百度/抖音）会明说「这条没法直接解析」。
2. 取正文：同源服务 → 配置的解析服务（多地址并行竞速）→ 公共代理，逐条尝试并显示进度；全失败时把每条通道的失败原因列出来，并给「复制链接 / 用浏览器打开 / 改成粘贴全文」。公众号正文按 `#js_content` 单独抽取，被微信拦住会直说是被拦。
3. 改写：6 种风格 × 3 档强度 × 6 个平台，支持自定义要求、去 AI 味、事实保真。
4. 自检：改写幅度、重合率（连续 12 字以上）、重复句数，全部本机计算。
5. 配图：配了出图模型就直接生成；没配就给三张图的提示词（3:4 / 16:9 / 1:1），复制到即梦、豆包、MJ 都能用。
6. 归档：作品存本地，可回看、复制、导出 Markdown。

**外观**
- 三档：跟随系统 / 深色 / 浅色。默认跟随系统，白天自动浅色，不用手动切。入口在「我的 → 外观」，右上角图标也能直进。

**公众号**
- 微信不提供公开的公众号热文榜，市面上号称「公众号热榜」的多是二手数据。所以这里不谈榜单，只做「贴链接取正文」，热榜页底部有直接入口。

**模型配置**
- 填 Base URL + Key，点「连接并获取可用模型」，读 `/models` 列出你账号下所有模型。
- 每个模型自动标注能力：`看图` `出图` `推理` `快` `大`，并给出「擅长什么」的一句话说明（按 GPT / Claude / Gemini / DeepSeek / Qwen / GLM / Kimi / 豆包 等家族匹配）。
- 出图模型单独配置，走 `/images/generations`，失败自动退回提示词方案。

## 目录

```
src/index.tpl.html      页面骨架模板（构建用，不要直接打开）
build.mjs               把模板 + CSS + JS + 热榜快照打成单文件 index.html
index.html              构建产物：单文件，双击就能跑，也是 GitHub Pages 的入口
assets/css/app.css      设计系统（深色优先，纸白可选）
assets/js/data.js       词库与 12 篇示例素材
assets/js/engine.js     本机改写引擎 + 配图提示词生成
assets/js/live.js       热榜 / 链接解析 / 模型 / 出图
assets/js/ui.js         视图渲染
assets/js/app.js        状态、路由、事件
scripts/fetch-hot.mjs   抓热榜，写 data/hot.json
data/hot.json           热榜快照（由 Action 每 15 分钟刷新）
server.js               可选：本地静态服务 + 后端代理
worker/index.js         解析服务（Cloudflare Worker 版，单文件零依赖）
worker/wrangler.toml    Worker 部署配置
.github/workflows/hot.yml
.github/workflows/deploy-worker.yml
```

改完 `assets/` 或 `src/` 里的文件，跑一次 `node build.mjs` 重新生成 `index.html`。

## 部署

### 方式 0：一条命令推到 GitHub（需要 token）

```bash
GH_TOKEN=github_pat_xxx node scripts/deploy.mjs
```

脚本会：校验 token → 建仓库（已存在就复用）→ 推送 → 打开 Pages → 等构建 → 打印网址。
可选：`REPO=名字`、`VISIBILITY=private`、`SKIP_WORKFLOW=1`（token 没有 Workflows 权限时用）、`DRY=1`（只检查不推送）。

Token 用 fine-grained 的，只勾这一个仓库，权限给 **Contents: Read and write**、**Pages: Read and write**、**Workflows: Read and write**，有效期 7 天。

### 方式 A：网页上传（不需要任何凭据）

要传的文件只有 5 个，全部在仓库根目录：

```
index.html              必需，整个应用都在里面
manifest.webmanifest    安装成 App 用（可选但建议）
sw.js                   断网可用（可选但建议）
icon.svg                图标
icon-512.png            图标（iOS 主屏幕用）
```

1. GitHub 网页 → New repository → 名字例如 `wenjiang` → **Public** → Create repository。
2. 仓库页 → Add file → **Upload files** → 一次选这 5 个文件 → Commit changes。
3. Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/ (root)` → Save。
4. 等 1 分钟，访问 `https://<你的用户名>.github.io/wenjiang/`。
5. 手机上用 Safari / Chrome 打开 → 分享 → 添加到主屏幕，就是一个全屏 App。

只传 `index.html` 也能跑，只是没有离线缓存和 Android 的「安装应用」入口。

这样部署出来的站点热榜显示为 `快照`（内联的那一份，页面会标出抓取时间）；联网正常时会先尝试实时接口，成功就显示 `实时`。

### 方式 B：整仓库部署（热榜能自动刷新）

把仓库完整推上去（含 `data/hot.json` 和 `.github/workflows/hot.yml`），Pages 设置同方式 A。

热榜快照由 Action 每 15 分钟抓一次并提交，不需要任何密钥。首次部署后去 Actions 页手动跑一次 `refresh-hot`，`data/hot.json` 就有内容。

> 没有后端时，热榜会先尝试浏览器直连公共聚合接口（有 CORS），失败再退回仓库里的快照。链接解析走阅读器代理链，公众号成功率不如自建后端。

### 它已经是一个 PWA

仓库里带了 `manifest.webmanifest` 和 `sw.js`：在 GitHub Pages（https）打开后，Safari「分享 → 添加到主屏幕」或 Chrome「安装应用」，就是一个全屏、无地址栏、断网也能打开的独立 App。入口也在「我的 → 装到主屏幕」。
单文件上传（方式 A）时没有 `sw.js`，iOS 仍能添加到主屏幕，但断网打不开。

### 关于白屏

以前把 `index.html` 单独下载下来只有两行字，是因为旧版本的页面骨架里引用了同目录的 `assets/`，单独一个文件当然加载不到。现在 `index.html` 是构建产物，这个问题不存在了；如果哪天真白屏，页面会在 2.5 秒后自己提示原因，不会留一片黑。

### 本地 / 自建（有后端，效果最好）

```bash
node build.mjs && node server.js   # http://localhost:3000
```

自带 `/api/health`、`/api/hot`、`/api/parse`。前端启动时会探测 `/api/health`，有后端就优先用它，链接解析和热榜都走同源，没有跨域问题。

## 关于「原创度」

没有做「原创度评分」这种无法验证的东西。页面上是两个可核对的数字：

- **改写幅度** = 输出里连续 12 字以上片段与原文不重合的比例
- **重合率** = 上述重合片段占全文的比例

同一套算法算出来的，加起来是 100。它们和平台判定不是一回事，页面上也这么写。

本机引擎是规则驱动的（同义词替换 + 长句拆分 + 段落重排 + 语体适配），短稿能做到 60–90% 幅度，长稿会明显偏低——所以界面上会直接告诉你「长文建议接模型」。接了大模型并走 AI 路径，改写幅度由模型决定。

## 合规边界

- 不承诺「过原创检测」，不做同义词替换式洗稿的营销话术。
- AI 生成内容默认在复制时附带声明（可在「我的」关闭），对应 2025 年 9 月施行的《人工智能生成合成内容标识办法》。
- 深度改写的定义是重排结构、换视角、补信息，不是改几个词。

## 隐私

素材和 Key 只存在浏览器 localStorage，请求直接发给你填的服务商。仓库里没有任何密钥。
