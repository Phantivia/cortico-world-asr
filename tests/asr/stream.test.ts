/**
 * 识别流:overlay 页与 SSE 订阅面。端口给 0 = 随机空闲口,测试之间不打架。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { get as httpGet } from 'node:http';
import { nullLogger } from 'cortico/core/util.ts';
import { AsrStream } from '../../src/stream.ts';

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor 超时'));
      }
    }, 10);
  });
}

/** 最小 SSE 客户端:攒 {id, data} 对 */
function subscribe(url: string, headers: Record<string, string> = {}) {
  const events: Array<{ id: number | null; data: Record<string, unknown> }> = [];
  let req: ReturnType<typeof httpGet>;
  const ready = new Promise<void>((resolve, reject) => {
    req = httpGet(url, { headers }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          let id: number | null = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = Number(line.slice(4));
            if (line.startsWith('data: ')) {
              events.push({ id, data: JSON.parse(line.slice(6)) as Record<string, unknown> });
            }
          }
        }
      });
      resolve();
    });
    req.on('error', reject);
  });
  return { events, ready, close: (): void => { req.destroy(); } };
}

function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('AsrStream', () => {
  const opened: AsrStream[] = [];
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const c of closers.splice(0)) c();
    for (const s of opened.splice(0)) await s.stop();
  });

  async function start(snapshot: () => Record<string, unknown> = () => ({})): Promise<AsrStream> {
    const s = new AsrStream({ preferredPort: 0, snapshot });
    await s.start(nullLogger());
    opened.push(s);
    return s;
  }

  it('overlay 页与它的两份静态资产都发得出来', async () => {
    const s = await start();
    const page = await fetchText(s.overlayUrl);
    expect(page.status).toBe(200);
    expect(page.body).toContain('语音识别 Overlay');
    expect((await fetchText(`http://127.0.0.1:${s.port}/overlay/app.js`)).body).toContain('EventSource');
    expect((await fetchText(`http://127.0.0.1:${s.port}/overlay/styles.css`)).body).toContain('--sub-scale');
    // 根路径就是 overlay:OBS 里少填一截也能出画面
    expect((await fetchText(`http://127.0.0.1:${s.port}/`)).body).toContain('<html');
    expect((await fetchText(`http://127.0.0.1:${s.port}/nope`)).status).toBe(404);
  });

  it('订阅先拿到现状快照,之后逐条推', async () => {
    const s = await start(() => ({ overlay: { maxLines: 3 }, recent: ['之前那句'] }));
    const sub = subscribe(s.streamUrl);
    await sub.ready;
    await waitFor(() => sub.events.length >= 1);
    expect(sub.events[0].data).toMatchObject({ type: 'snapshot', recent: ['之前那句'] });
    s.emit('text', { text: '新来的一句' });
    await waitFor(() => sub.events.length >= 2);
    expect(sub.events[1].data).toMatchObject({ type: 'text', text: '新来的一句' });
    expect(s.subscriberCount).toBe(1);
    closers.push(sub.close);
  });

  it('断线续传:Last-Event-ID 之后的补发,之前的不重发', async () => {
    const s = await start();
    s.emit('text', { text: '第一句' });
    s.emit('text', { text: '第二句' });
    const sub = subscribe(s.streamUrl, { 'Last-Event-ID': '1' });
    await sub.ready;
    await waitFor(() => sub.events.length >= 2);
    const texts = sub.events.map((e) => e.data.text).filter(Boolean);
    expect(texts).toEqual(['第二句']);
    closers.push(sub.close);
  });

  it('停止时订阅者一起收摊', async () => {
    const s = await start();
    const sub = subscribe(s.streamUrl);
    await sub.ready;
    await waitFor(() => s.subscriberCount === 1);
    await s.stop();
    expect(s.up).toBe(false);
    closers.push(sub.close);
  });
});
