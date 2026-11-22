/**
 * 文匠解析服务 · 阿里云函数计算（FC 3.0 Web 函数）适配层
 * ------------------------------------------------------------
 * 为什么需要它：
 *   Cloudflare 的 `*.workers.dev` 在国内被按域名（SNI）拦掉了，
 *   换 DNS、改 hosts、固定 IP 都没用——只能换域名或换平台。
 *   这个文件把同一份 worker/index.js 原样跑在阿里云国内节点上，
 *   拿到 `https://xxx.cn-hangzhou.fcapp.run` 这种国内直连地址。
 *
 * 用法：函数计算 FC 3.0 → 创建函数 → 选「Web 函数」→ Node.js 20 →
 *       把 worker/ 整个目录打包上传 → 启动命令 `node aliyun-fc/index.mjs`
 *       监听端口 9000（FC 默认），其余按 README 点几下即可。
 *
 * 本地自测：
 *   node worker/aliyun-fc/index.mjs
 *   curl "http://127.0.0.1:9000/api/health"
 */

import http from 'node:http';
import worker from '../index.js';

const PORT = Number(process.env.PORT || process.env.FC_SERVER_PORT || 9000);

/* 这些头由 Node 的 http 自己管，透传给 undici 会报错 */
const DROP_REQ = /^(host|connection|content-length|transfer-encoding|keep-alive|upgrade|expect)$/i;
const DROP_RES = /^(connection|content-length|transfer-encoding|keep-alive)$/i;

function toWebRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const target = `${proto}://${host}${req.url || '/'}`;

  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    const v = req.rawHeaders[i + 1];
    if (!k || v === undefined || DROP_REQ.test(k)) continue;
    try { headers.append(k, v); } catch { /* 非法头直接丢 */ }
  }

  const init = { method: req.method || 'GET', headers };
  if (init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = req;
    init.duplex = 'half'; // undici 要求流式 body 显式声明
  }
  return new Request(target, init);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const out = await worker.fetch(toWebRequest(req), process.env, {});
    res.statusCode = out.status;
    out.headers.forEach((v, k) => {
      if (!DROP_RES.test(k)) res.setHeader(k, v);
    });
    const buf = Buffer.from(await out.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 }));
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`wenjiang-parse (aliyun fc) listening on 0.0.0.0:${PORT}`);
});

/* FC 缩容时会发 SIGTERM，给它 3 秒把手上的请求收尾 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
