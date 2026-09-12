/**
 * 转写端点客户端:请求长什么样、回执怎么解、失败怎么说。
 * 假 fetch 拿到的是真 multipart 请求体,所以 WAV 头也一并验了。
 */
import { describe, expect, it, vi } from 'vitest';
import { AsrClient, looksHallucinated, wavFromPcm16 } from '../../src/asr-client.ts';

const PCM = new Int16Array([0, 1000, -1000, 32767, -32768]);

function client(fetchImpl: typeof fetch, over: Partial<{ language: string }> = {}): AsrClient {
  return new AsrClient({
    baseUrl: 'http://127.0.0.1:8793/v1/',
    model: 'whisper-large-v3-turbo',
    language: 'zh',
    timeoutMs: 5000,
    fetchImpl,
    ...over,
  });
}

describe('WAV 封装', () => {
  it('44 字节头 + 原样样本,采样率与声道写在头里', () => {
    const wav = wavFromPcm16(PCM, 16_000);
    expect(wav.length).toBe(44 + PCM.length * 2);
    const text = Buffer.from(wav.subarray(0, 4)).toString('ascii');
    expect(text).toBe('RIFF');
    expect(Buffer.from(wav.subarray(8, 12)).toString('ascii')).toBe('WAVE');
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16); // 16-bit
    expect(view.getUint32(40, true)).toBe(PCM.length * 2);
    // 样本原样:第二个是 1000
    expect(view.getInt16(44 + 2, true)).toBe(1000);
  });
});

describe('转写请求', () => {
  it('打的是 /audio/transcriptions,带上模型、语言与 0 温度', async () => {
    let seen: { url: string; form: FormData } | null = null;
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), form: init!.body as FormData };
      return new Response(JSON.stringify({ text: '听得见吗' }), { status: 200 });
    });
    const res = await client(fake as unknown as typeof fetch).transcribe(PCM, 16_000);
    expect(res.text).toBe('听得见吗');
    expect(res.error).toBeNull();
    expect(seen!.url).toBe('http://127.0.0.1:8793/v1/audio/transcriptions');
    expect(seen!.form.get('model')).toBe('whisper-large-v3-turbo');
    expect(seen!.form.get('language')).toBe('zh');
    expect(seen!.form.get('temperature')).toBe('0');
    expect(seen!.form.get('file')).toBeInstanceOf(Blob);
  });

  it('language=auto 就不带这一项,让服务端自己猜', async () => {
    let form: FormData | null = null;
    const fake = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      form = init!.body as FormData;
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    });
    await client(fake as unknown as typeof fetch, { language: 'auto' }).transcribe(PCM, 16_000);
    expect(form!.get('language')).toBeNull();
  });

  it('裸文本回执也认(response_format=text 的服务端)', async () => {
    const fake = vi.fn(async () => new Response('  就这一句  ', { status: 200 }));
    expect((await client(fake as unknown as typeof fetch).transcribe(PCM, 16_000)).text).toBe('就这一句');
  });

  it('非 2xx 与网络错误都回一句人话,不抛', async () => {
    const bad = vi.fn(async () => new Response('model not found', { status: 500 }));
    const res = await client(bad as unknown as typeof fetch).transcribe(PCM, 16_000);
    expect(res.text).toBe('');
    expect(res.error).toContain('HTTP 500');
    expect(res.error).toContain('model not found');

    const dead = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const res2 = await client(dead as unknown as typeof fetch).transcribe(PCM, 16_000);
    expect(res2.error).toContain('ECONNREFUSED');
  });
});

describe('幻觉过滤', () => {
  it('空白、标点、字幕组落款、括号标注都挡下', () => {
    for (const t of ['', '   ', '。。。', '字幕由 Amara.org 社区提供', '谢谢观看', '[音乐]', '(笑)', 'Thank you.']) {
      expect(looksHallucinated(t), t).toBe(true);
    }
  });

  it('正常的话放行', () => {
    for (const t of ['听得见吗', '今天天气不错,要不要出去走走', '把那个箱子打开']) {
      expect(looksHallucinated(t), t).toBe(false);
    }
  });
});
