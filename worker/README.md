# 文匠解析服务（Cloudflare Worker）

浏览器有同源策略，静态页面（GitHub Pages）读不了别人的网页。要「粘贴链接取正文」，
就必须有一台服务器代抓——这个目录就是那台服务器，一个文件、零依赖。

## 它能做什么

| 接口 | 说明 |
| --- | --- |
| `GET /` | 状态页，会把你该填进 App 的地址显示出来 |
| `GET /api/health` | `{ ok, version, runtime }`，App 用它探活 |
| `GET /api/parse?url=` | 抓取正文 → `{ ok, title, text, chars }` |

- 公众号（`mp.weixin.qq.com`）带 `Referer` 直取 `#js_content`，能识别「环境异常 / 文章已删除」
- 普通站点按 `#js_content` → `#paragraph` → `.post_content` → `article` → 通用内容容器的优先级定位正文，
  再按「评论 / 推荐 / 责任编辑 / 免责声明」截掉尾巴
- 内置 10 分钟小缓存、UA 轮换、13 秒超时、内网地址拦截
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
