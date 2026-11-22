# 文匠解析服务（Cloudflare Worker）

浏览器有同源策略，静态页面（GitHub Pages）读不了别人的网页。要「粘贴链接取正文」，
就必须有一台服务器代抓——这个目录就是那台服务器，一个文件、零依赖。

## 先看这一节：国内打不开 `*.workers.dev`

如果你部署完，在手机上一直「连不上 / 转圈到超时」，**不是配置错了，是域名被拦了**。

`workers.dev`（以及 `pages.dev`、`vercel.app`、`netlify.app`）在国内被按域名做 SNI 阻断：
DNS 会被污染成假 IP，就算你手动固定到 Cloudflare 的真实 IP，TLS 握手时 SNI 里带着
`workers.dev` 也会被立刻重置。所以换 DNS（8.8.8.8 / DoH）、改 hosts、换 IP、开热点，
**一个都没用**。移动网络最严重，因为国际出口最紧张。

三条路，按「改动量」排：

| 方案 | 改什么 | 花多久 | 花钱 | 国内速度 |
| --- | --- | --- | --- | --- |
| ① 给这个 Worker 绑自己的域名 | 代码一行不改，只加一条 Custom Domain | 10 分钟（域名 NS 生效可能要几小时） | 域名可以白嫖（`eu.org`、DNSHE 的免费二级域） | 电信 80–150ms / 联通 120–200ms / 移动 200–400ms，晚高峰会抖 |
| ② 什么都不部署 | App 里地址留空 | 0 分钟 | 免费 | 走 App 内置解析通道，看公共通道脸色 |

**方案①怎么做**：Cloudflare 控制台 → Workers 和 Pages → 选中这个 Worker → Settings →
Domains & Routes → **Add → Custom Domain** → 填 `parse.你的域名`。前提是这个域名的 NS
已经托管在 Cloudflare（免费版就行）。加完地址就从 `xxx.workers.dev` 变成
`https://parse.你的域名`，App 里换掉即可。

> 顺带提醒：微信内置浏览器对**未备案的境外域名**更严格，容易白屏或折叠。
> 要发给别人用又不想折腾，就走方案②，把地址留空用 App 内置通道。

> **已移除的方案：阿里云函数计算（FC）。** 它虽有 3 个月试用额度，但本质是**按量付费**：
> 试用到期或欠费即停机（有用户收到欠费停机、即将释放资源的通知）。凡是「先免费后按量」
> 的云函数都不符合本项目「长期零成本」的要求，已从仓库移除，不要再部署它。

## 它能做什么

| 接口 | 说明 |
| --- | --- |
| `GET /` | 状态页，会把你该填进 App 的地址显示出来 |
| `GET /api/health` | `{ ok, version, runtime }`，App 用它探活 |
| `GET /api/parse?url=` | 抓取正文 → `{ ok, title, text, chars }` |
| `GET /api/meta?url=&src=` | 只读元信息 → `{ ok, title, desc, category, published, author, site, images[] }`，给详情页和「原文配图」用 |

- 公众号（`mp.weixin.qq.com`）带 `Referer` 直取 `#js_content`，能识别「环境异常 / 文章已删除」
- 普通站点按 `#js_content` → `#paragraph` → `.post_content` → `article` → 通用内容容器的优先级定位正文，
  再按「评论 / 推荐 / 责任编辑 / 免责声明」截掉尾巴
- `/api/meta` 把分类、发布时间（og / JSON-LD / 公众号 `var ct`）、头图与正文配图一并解出来，按文件名去重、滤掉占位图
- 内置 10 分钟小缓存（正文与页面分开存，点完详情再点解析不会重复抓）、UA 轮换、13 秒超时、内网地址拦截
- 免费额度：**每天 10 万次请求**，个人用绰绰有余

## 三种上线方式，选一个

### 方式一：一键部署（推荐，约 2 分钟）

1. 打开 <https://deploy.workers.cloudflare.com/?url=https://github.com/oynana8023/wenjiang/tree/main/worker>
2. 登录 Cloudflare（免费注册，不用信用卡）→ 点 **Deploy**
3. 拿到形如 `https://wenjiang-parse.你的子域.workers.dev` 的地址
4. 打开 App → **我的 → 解析服务** → 把这个地址粘进去 → **保存并检测**，看到绿色的 `在线 · xx ms` 就好了

### 方式二：命令行

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

### 方式三：GitHub Actions 自动部署（改代码即上线）

在仓库 **Settings → Secrets and variables → Actions** 里加两个 Secret：

- `CF_API_TOKEN`：Cloudflare 后台 → My Profile → API Tokens → 用模板 *Edit Cloudflare Workers* 生成
- `CF_ACCOUNT_ID`：Cloudflare 后台右侧栏的 Account ID

之后每次改到 `worker/` 目录，推送就会自动部署（见 `.github/workflows/deploy-worker.yml`）。
没配 Secret 时这个工作流会自动跳过，不会报红。

## 可选：加个访问口令

Worker → Settings → Variables and Secrets → 新增 `PARSE_KEY`（比如 `wj-8f3k2`）。
之后请求必须带 `&key=wj-8f3k2`，否则返回 401。
App 的「解析服务」面板里有对应的「访问口令」输入框，填一次就行。

## 本地调试

```bash
cd worker
npx wrangler dev          # http://127.0.0.1:8787
curl "http://127.0.0.1:8787/api/parse?url=https://sspai.com/post/119191"
```

## 自检清单

```bash
curl "https://<你的域名>/api/health"
# {"ok":true,"version":"3.0.0","runtime":"worker"}

curl "https://<你的域名>/api/parse?url=https://mp.weixin.qq.com/s/xxxxxxxx"
# {"ok":true,"title":"...","text":"...","chars":2182}
```

如果 `/api/parse` 返回 `{ok:false,error:"HTTP 403"}`，多半是目标站点风控（知乎、微博、36氪 这类站点
对非浏览器请求本来就不友好），换篇文章再试即可。
