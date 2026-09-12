/**
 * 识别流服务:worlds-asr 的对外网络面。
 *
 * - `GET /overlay`(页面):实时字幕层,透明底。OBS browser source 订这里,
 *   控制台的 overlay 面板也用 iframe 嵌同一份——**只有一份渲染实现**。
 * - `GET /stream`(SSE,单向广播):overlay 与控制台面板共用的数据面。
 *   事件前向兼容:只加新类型不改旧的,订阅者忽略不认识的 type。
 *
 * 单向订阅用 SSE 而不是 WS:传输层物理上长不出"订阅者回话"的分支,断线续传
 * (Last-Event-ID)与重连是 EventSource 原生的。
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';

/** overlay 页静态资产;请求时现读,改页面刷新即见 */
const OVERLAY_DIR = fileURLToPath(new URL('./overlay/', import.meta.url));
const OVERLAY_FILES: Record<string, { file: string; type: string }> = {
  '/overlay': { file: 'overlay.html', type: 'text/html; charset=utf-8' },
  '/overlay/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/overlay/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

/** SSE 保活注释间隔,防止代理关掉空闲连接 */
const KEEPALIVE_MS = 15_000;
/** Last-Event-ID 续传的环形缓冲条数 */
const REPLAY_CAP = 128;
/**
 * OBS browser source 的 CEF 会把不足约 2KB 的流式响应攒在网络层,
 * EventSource 收不到 snapshot,页面就是空的。开流先垫一块注释。
 */
const SSE_PAD = `: ${' '.repeat(2048)}\n\n`;

interface AsrStreamOptions {
  /** 偏好端口;被占自动顺延(0 = 随机空闲口) */
  preferredPort: number;
  host?: string;
  /** 新订阅者的现状快照(snapshot 事件的数据体) */
  snapshot: () => Record<string, unknown>;
}

export class AsrStream {
  private http: Server | null = null;
  private boundPort: number | null = null;
  private readonly listenHost: string;
  private readonly subscribers = new Set<ServerResponse>();
  private seq = 0;
  private readonly replay: Array<{ seq: number; payload: string }> = [];
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: AsrStreamOptions) {
    this.listenHost = opts.host ?? '127.0.0.1';
  }

  get port(): number {
    return this.boundPort ?? this.opts.preferredPort;
  }

  get up(): boolean {
    return this.http !== null;
  }

  /** 订阅者数(overlay 页 / OBS browser source / 控制台面板) */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get overlayUrl(): string {
    return `http://${this.listenHost}:${this.port}/overlay`;
  }

  get streamUrl(): string {
    return `http://${this.listenHost}:${this.port}/stream`;
  }

  async start(log: Logger): Promise<void> {
    const preferred = this.opts.preferredPort;
    const maxAttempts = preferred === 0 ? 1 : 50;
    let server: Server | null = null;
    let lastErr: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = preferred === 0 ? 0 : preferred + i;
      const attempt = createServer((req, res) => this.onRequest(req.url ?? '', res));
      try {
        await new Promise<void>((resolve, reject) => {
          attempt.once('error', reject);
          attempt.listen(candidate, this.listenHost, () => {
            attempt.removeListener('error', reject);
            resolve();
          });
        });
        server = attempt;
        if (i > 0) log.info(`识别流端口 ${preferred} 已被占用,改用 ${candidate}`);
        break;
      } catch (err) {
        lastErr = err;
        attempt.close();
        if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE' || preferred === 0) throw err;
      }
    }
    if (!server) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`识别流端口 ${preferred}–${preferred + maxAttempts - 1} 均不可用`);
    }
    this.http = server;
    this.boundPort = (server.address() as AddressInfo).port;
    this.keepalive = setInterval(() => {
      for (const res of this.subscribers) {
        try { res.write(':hb\n\n'); } catch { /* 掉线的由 close 事件清理 */ }
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
    log.info(`识别流已启动 ${this.overlayUrl}`);
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const res of [...this.subscribers]) {
      try { res.end(); } catch { /* 收尾 */ }
    }
    this.subscribers.clear();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
    this.boundPort = null;
  }

  /** 广播一条;seq 单调,断线订阅者凭 Last-Event-ID 续传近期条目 */
  emit(type: string, data: Record<string, unknown>): void {
    const seq = ++this.seq;
    const payload = `id: ${seq}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    this.replay.push({ seq, payload });
    if (this.replay.length > REPLAY_CAP) this.replay.shift();
    for (const res of this.subscribers) {
      try { res.write(payload); } catch { /* 掉线的由 close 事件清理 */ }
    }
  }

  private onRequest(url: string, res: ServerResponse): void {
    const raw = url.split('?')[0];
    const path = raw === '/' ? '/overlay' : raw.replace(/\/$/, '') || '/';
    const asset = OVERLAY_FILES[path];
    if (asset) {
      try {
        const body = readFileSync(OVERLAY_DIR + asset.file);
        res.writeHead(200, {
          'Content-Type': asset.type,
          'Cache-Control': 'no-cache, no-store',
          'Access-Control-Allow-Origin': '*',
        }).end(body);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('overlay asset unreadable');
      }
      return;
    }
    if (path !== '/stream') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('asr stream: GET /overlay | /stream');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // 订阅是公开单向面:控制台在另一个端口,OBS 在另一个进程
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    res.write(SSE_PAD);
    const lastId = Number(res.req.headers['last-event-id']);
    if (Number.isFinite(lastId)) {
      for (const item of this.replay) if (item.seq > lastId) res.write(item.payload);
    }
    res.write(`data: ${JSON.stringify({ type: 'snapshot', ...this.opts.snapshot() })}\n\n`);
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }
}
