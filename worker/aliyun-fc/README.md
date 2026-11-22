# 国内直连版解析服务（阿里云函数计算 FC 3.0）

`*.workers.dev` 在中国大陆被按域名拦掉了（SNI 阻断）。换 DNS、改 hosts、把域名固定到
Cloudflare 真实 IP，全都没用——被拦的是域名本身。要么给 Worker 换个域名，要么把同一份代码
挪到国内节点上跑。这个目录就是后者。

跑起来之后拿到的是 `https://xxx.cn-hangzhou.fcapp.run` 这种**国内直连、免备案**的地址，
接口和 Cloudflare 版完全一致（`/api/health`、`/api/parse`、`/api/meta`、`/api/img`、`/api/llm`）。

## 成本

- 每月前 **100 万次调用 + 40 万 CU-秒** 免费，个人用不完。
- 默认域名 `*.fcapp.run` 无需 ICP 备案。
- 需要阿里云账号完成实名认证（个人身份证即可），不需要信用卡、不需要买任何资源包。

## 部署（网页控制台，约 10 分钟）

1. 打开 <https://fc.console.aliyun.com/>，首次进入按提示开通「函数计算 FC」（选按量付费）。
2. 左侧 **函数** → **创建函数** → 选 **Web 函数**（不是「事件函数」）。
3. 基本设置：
   - 函数名称：`wenjiang-parse`
   - 运行环境：**Node.js 20**（控制台里如果只有「Node.js 24（公测中）」，选它也行；
     不要选「自定义运行时 / Debian 12」，那套要自己写启动脚本）
   - 启动命令：`node aliyun-fc/index.mjs`
   - 监听端口：`9000`（控制台默认可能是 60 或其他值，一定改成 9000）
   - 规格：最小 0.5 vCPU / 512 MB 足够
4. 代码：选 **通过 ZIP 包上传代码**，把现成的代码包传上去：

   ```
   https://raw.githubusercontent.com/oynana8023/wenjiang/main/wenjiang-parse-fc.zip
   ```

   手机浏览器打开这个链接就会下载这个文件（22 KB）。想自己打包也可以，在本地仓库根目录执行：

   ```bash
   cd worker
   zip -r ../wenjiang-parse.zip index.js package.json aliyun-fc
   ```

   两种方式内容一样。**不需要安装依赖**（代码零依赖，`wrangler` 只是本地开发用的）。
5. 高级配置里把**实例上限**设成 5，**单实例并发**设成 20，冷启动会少很多。
6. 创建完成后，在函数详情页找到 **公网访问地址**，形如：

   ```
   https://wenjiang-parse-xxxxx.cn-hangzhou.fcapp.run
   ```

7. 先把这一段去掉：`/` 后面的路径不要，只留到 `.fcapp.run`。然后在 App 里
   **我的 → 解析服务 → 服务地址** 填进去 → **保存并检测**，看到绿色「在线 · xx ms」就成了。

## 两个必须知道的限制

- **强制 `content-disposition: attachment`**：阿里云对所有 `fcapp.run` 响应都加这个头，
  浏览器直接打开会变成下载。但 App 是用 `fetch()` 读 body 的，**不受影响**。
- **任何 3xx 跳转都会被网关改成 400** `ExternalRedirectForbidden`。本服务不做重定向，
  所以没影响；如果你自己改代码加了跳转，记得改掉。

## 验证

```bash
curl "https://你的地址.cn-hangzhou.fcapp.run/api/health"
# {"ok":true,"version":"3.6.0","runtime":"worker"}

curl "https://你的地址.cn-hangzhou.fcapp.run/api/parse?url=https://sspai.com/post/119191"
# {"ok":true,"title":"...","chars":1124,"images":[...5 张]...}
```

## 本地跑

```bash
node worker/aliyun-fc/index.mjs
curl "http://127.0.0.1:9000/api/health"
```

## 可选：加访问口令

函数配置 → 环境变量 → 新增 `PARSE_KEY=wj-xxxx`。之后请求要带 `&key=wj-xxxx`，
App 的「访问口令」输入框填同一个值即可。

## 不想用阿里云？

同一份 `worker/index.js` 也能跑在任何支持 Node 20 的地方（腾讯云 CloudBase、Zeabur、
自己的 VPS、家里的 NAS）。只要 `node aliyun-fc/index.mjs` 能起来、对外暴露 9000 端口就行。
