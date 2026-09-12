/**
 * 语音识别端点客户端:一段 PCM → 一句文本。
 *
 * 协议只认 **OpenAI 兼容的 `POST /audio/transcriptions`**(multipart,字段 `file`)。
 * 本地 FireRedASR2-AED 的 CPU 与 CUDA 档都使用这条协议，换档、换权重、
 * 换成别的本地实现,World 这一侧一个字都不用动。
 *
 * 请求带 `language`:中文场景下不指定语言时,whisper 系模型会拿前几百毫秒去猜,
 * 短句上猜错的代价是整句变成日文假名。
 */

interface AsrClientOptions {
  /** 形如 http://127.0.0.1:8792/v1(不带尾斜杠也行) */
  baseUrl: string;
  model: string;
  /** ISO 639-1;'auto' = 让服务端自己猜 */
  language: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface AsrResult {
  text: string;
  /** 端到端耗时(ms) */
  ms: number;
  /** 失败原因;成功为 null */
  error: string | null;
}

/** 16-bit 单声道 PCM → WAV 字节(44 字节头 + 原样样本) */
export function wavFromPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const bytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** 服务端回的形状:JSON 的 {text},或 response_format=text 时的裸文本 */
function textOf(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const json = JSON.parse(trimmed) as { text?: unknown; error?: unknown };
    if (typeof json.text === 'string') return json.text;
    return '';
  } catch {
    return trimmed;
  }
}

export class AsrClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AsrClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get endpoint(): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<AsrResult> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([wavFromPcm16(pcm, sampleRate) as BlobPart], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', this.opts.model);
    form.append('response_format', 'json');
    // 采样温度 0:听错了宁可少几个字,不要它自己编
    form.append('temperature', '0');
    if (this.opts.language && this.opts.language !== 'auto') form.append('language', this.opts.language);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      const body = await res.text();
      if (!res.ok) {
        return { text: '', ms: Date.now() - started, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { text: textOf(body).trim(), ms: Date.now() - started, error: null };
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError'
        ? `识别超时(${this.opts.timeoutMs}ms)`
        : (err as Error).message;
      return { text: '', ms: Date.now() - started, error: msg };
    }
  }
}

/**
 * 识别结果里那些"没有人在说话"的产物。
 *
 * whisper 系模型在纯噪声上会稳定地吐出训练集里的高频片段(字幕组落款、
 * "谢谢观看"这类)。它们与真话在文本上无从分辨,只能按名单挡:漏一条的代价是
 * 她收到一句没人说过的话,并且会当真去回应。
 */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /^[\s。.,、!?!?…~-]*$/,
  /字幕|谢谢观看|请不吝点赞|订阅|转发|打赏|明镜与点点栏目/,
  /^(thank you|thanks for watching|subtitles by|you)[\s.!]*$/i,
  /^[\s]*\[.*\][\s]*$/, // [音乐] [掌声] 这类标注
  /^\(.*\)$/,
];

export function looksHallucinated(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(t));
}
