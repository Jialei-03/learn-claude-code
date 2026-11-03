// 记录代理：Claude Code 把请求发给它，它原样转发给真正的模型服务，同时把请求和响应记下来。
// 这是观察一个程序“实际发出了什么”的标准做法：看的是你自己电脑上的网络流量。
import { createServer } from 'node:http';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';

export interface Captured {
  id: number;
  method: string;
  path: string;
  /** 请求头（密钥已隐去） */
  headers: Record<string, string>;
  /** 请求体（JSON 解析后） */
  body: any;
  status?: number;
  /** 响应体原文（流式响应就是整段 SSE 文本） */
  response?: string;
  ms?: number;
}

const SECRET = /^(x-api-key|authorization|cookie)$/i;

export async function startProxy(upstream: string) {
  const captured: Captured[] = [];
  let next = 1;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const target = new URL(req.url ?? '/', upstream);
      const record: Captured = {
        id: next++, method: req.method ?? 'GET', path: target.pathname + target.search,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, SECRET.test(k) ? '<redacted>' : String(v)])),
        body: (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return raw.length ? raw.toString('utf8') : undefined; } })(),
      };
      captured.push(record);
      const start = Date.now();
      // 要求不压缩的响应，记下来的才是可读的文本
      const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' };
      const upstreamReq = request(target, { method: req.method, headers }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        const body: Buffer[] = [];
        upstreamRes.on('data', d => { body.push(d); res.write(d); });
        upstreamRes.on('end', () => {
          res.end();
          record.status = upstreamRes.statusCode;
          record.response = Buffer.concat(body).toString('utf8');
          record.ms = Date.now() - start;
        });
      });
      upstreamReq.on('error', error => { record.status = 502; record.response = String(error); res.writeHead(502).end(String(error)); });
      upstreamReq.end(raw);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    captured,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
