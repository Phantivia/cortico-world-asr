/**
 * 把连续的麦克风流切成一句一句,再把识别结果打包成一条投递。
 *
 * 两级都是纯逻辑(不碰声卡、不碰网络),因为这两处的判据全是可调参数,而参数调
 * 得对不对只有拿录音的形状去验才说得清。
 *
 * **切分**(Segmenter):能量门限 + 起说时长 + 收尾静音 的状态机。语音识别的输入
 * 单位是"一句",而声卡给的是每 20ms 一帧;中间这一层决定"哪一段值得送去识别"。
 * 门限之前那几帧要带上(preRoll)——人开口的第一个字总是先于能量越线的那一刻。
 *
 * 静音这一侧是**两级门限**,分开的是两件不同的事:
 *
 * - `dispatchSilenceMs`(短,送去转写):停这么久就把手上这段交出去。转写在显卡档
 *   要 ~200ms 且与音频长短几乎无关(0.5s 音频 157ms / 7s 音频 285ms,本机 large-v3
 *   实测),所以早交出去 = 那 200ms 挪进静音窗里跑,而不是排在它后面。
 * - `silenceMs`(长,这一段真的说完了):在它到点之前,`settleRemainingMs` 一直报"还
 *   没完",打包层据此继续持有。人在窗口里接着说,后半段照旧接上,两半并成一条——
 *   所以短门限不会把句子切碎,它只把**转写**提前,不把**发车**提前。
 *
 * **打包**(Packer):识别结果不是一句一投。人说话是一串短句,逐句唤醒她等于把
 * 一段话拆成五次打断。并句这件事现在由上面那条长门限管;`joinGapMs` 退成"在收尾
 * 静音之外还想多等多久",默认 0。流水线空闲后，`maxHoldMs` 到期的批次立即发车。
 */

/** 一句:16-bit 单声道 PCM,附上它在流里的位置 */
export interface Utterance {
  pcm: Int16Array;
  /** 相对于采集开始的毫秒数 */
  startMs: number;
  durationMs: number;
  /** 因为说得太长被强切的,而不是自然收尾的 */
  forced: boolean;
}

export interface SegmentConfig {
  /** 判为"有人在说"的电平门槛(dBFS)。安静房间的底噪常在 -60 上下 */
  thresholdDb: number;
  /** 连续超过门槛多久才算开口(ms):咳嗽、键盘、鼠标点击挡在这一关 */
  minSpeechMs: number;
  /**
   * 静音多久就把手上这段送去转写(ms)。短于 `silenceMs` 的那一级门限:交得早,
   * 转写就跑在静音窗里而不是排在它后面。人接着说的话后半段照旧接上,由打包层并回
   * 一条,所以这里给短不会把句子切成两半。给到 `silenceMs` 及以上就退回单级门限。
   */
  dispatchSilenceMs: number;
  /** 说完之后静音多久算一句结束(ms):打包层据此决定发不发车 */
  silenceMs: number;
  /** 一句最长多久强切(ms):她不能等一个人讲完五分钟才听见第一个字 */
  maxUtteranceMs: number;
  /** 触发点往前多带一段(ms) */
  preRollMs: number;
  /** 短于这个的片段直接丢(ms):门限抖动出来的碎片不值得送去识别 */
  minUtteranceMs: number;
}

export const SEGMENT_DEFAULTS: SegmentConfig = {
  thresholdDb: -42,
  minSpeechMs: 180,
  dispatchSilenceMs: 250,
  silenceMs: 500,
  maxUtteranceMs: 15_000,
  preRollMs: 320,
  minUtteranceMs: 350,
};

/** 一帧的均方根电平(dBFS);全零帧记 -100 而不是 -Infinity */
export function rmsDb(frame: Int16Array): number {
  if (frame.length === 0) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frame.length);
  return rms <= 1e-5 ? -100 : Math.max(-100, 20 * Math.log10(rms));
}

function concat(frames: Int16Array[]): Int16Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

export class Segmenter {
  private cfg: SegmentConfig;
  private readonly frameMs: number;
  /** 门限之前的那几帧,长度按 preRollMs 截 */
  private preRoll: Int16Array[] = [];
  private collected: Int16Array[] = [];
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private elapsedMs = 0;
  private startMs = 0;
  private lastDb = -100;

  constructor(cfg: SegmentConfig, frameMs: number) {
    this.cfg = cfg;
    this.frameMs = frameMs;
  }

  /** 热改:门槛与时长随时可调,不打断正在收的这一句 */
  configure(cfg: SegmentConfig): void {
    this.cfg = cfg;
  }

  /** 最近一帧的电平(dBFS);面板的电平条读它 */
  get level(): number {
    return this.lastDb;
  }

  /** 此刻是否正在收一句 */
  get active(): boolean {
    return this.speaking;
  }

  /**
   * 距"这一段真的说完了"还差多少毫秒;0 = 已经过了收尾静音,或此刻无话可等。
   *
   * 短门限把音频交出去之后,人还有 `silenceMs - dispatchSilenceMs` 的窗口可以接着说。
   * 打包层拿这个数决定继续持有还是发车——**转写提前,发车不提前**,靠的就是这一条。
   * 起说判定中(能量已越线、还不够 `minSpeechMs`)同样算"没说完":那 180ms 里既不
   * `active` 也没在攒静音,不报出来就会在这个缝里把前半句先送走。
   */
  get settleRemainingMs(): number {
    if (this.speaking) return 0; // 还在说,由 active 挡着
    if (this.aboveMs > 0) return Math.max(0, this.cfg.minSpeechMs - this.aboveMs);
    if (this.belowMs === 0) return 0;
    return Math.max(0, this.cfg.silenceMs - this.belowMs);
  }

  /** 喂一帧,拿回这一帧结束时切出来的句子(通常是空的) */
  push(frame: Int16Array): Utterance[] {
    const db = rmsDb(frame);
    this.lastDb = db;
    this.elapsedMs += this.frameMs;
    const loud = db >= this.cfg.thresholdDb;
    const out: Utterance[] = [];

    if (!this.speaking) {
      this.preRoll.push(frame);
      const keep = Math.max(1, Math.ceil(this.cfg.preRollMs / this.frameMs));
      while (this.preRoll.length > keep) this.preRoll.shift();
      this.aboveMs = loud ? this.aboveMs + this.frameMs : 0;
      // 交出去之后这条静音接着数:长门限没到之前,打包层还得替这一段留着位子。
      // 封顶在长门限上,免得安静一整天把这个数攒成天文数字。
      this.belowMs = loud ? 0 : Math.min(this.belowMs + this.frameMs, this.cfg.silenceMs);
      if (this.aboveMs >= this.cfg.minSpeechMs) {
        this.speaking = true;
        this.belowMs = 0;
        this.collected = [...this.preRoll];
        this.startMs = this.elapsedMs - this.collected.length * this.frameMs;
        this.preRoll = [];
      }
      return out;
    }

    this.collected.push(frame);
    this.belowMs = loud ? 0 : this.belowMs + this.frameMs;
    const heldMs = this.collected.length * this.frameMs;
    // 短门限交货;长门限那一半留给 settleRemainingMs,不在这里挡。给反了(短的比长的
    // 还长)就退回单级,以长的为准。
    const dispatchMs = Math.min(this.cfg.dispatchSilenceMs, this.cfg.silenceMs);
    if (this.belowMs >= dispatchMs) {
      // belowMs 不清零:这条静音还要接着数到 silenceMs
      const done = this.finish(false);
      if (done) out.push(done);
    } else if (heldMs >= this.cfg.maxUtteranceMs) {
      // 强切之后照旧在"说话中":人还没停,下一段接着收
      const done = this.finish(true);
      if (done) out.push(done);
      this.speaking = true;
      this.collected = [];
      this.startMs = this.elapsedMs;
      this.belowMs = 0;
    }
    return out;
  }

  /** 停止采集时把手上这半句交出来(够长的话) */
  flush(): Utterance | null {
    const tail = this.speaking ? this.finish(false) : null;
    // 不收音了就没有"还没说完"这回事:留着计数会让打包层永远等一个不再来的帧
    this.aboveMs = 0;
    this.belowMs = 0;
    return tail;
  }

  private finish(forced: boolean): Utterance | null {
    const frames = this.collected;
    this.collected = [];
    this.speaking = false;
    this.aboveMs = 0;
    const durationMs = frames.length * this.frameMs;
    if (durationMs < this.cfg.minUtteranceMs) return null;
    return { pcm: concat(frames), startMs: this.startMs, durationMs, forced };
  }
}

// ---------------------------------------------------------------------------

export interface PackConfig {
  /**
   * 转写落地且收尾静音结束后的额外等待时间（ms），默认 0。
   * silenceMs 与 settleRemainingMs 处理短停顿合并；后到句子由总线下一批带走。正值直接增加响应延迟。
   */
  joinGapMs: number;
  /** 一条最多攒多久(ms):再连着说也要发车 */
  maxHoldMs: number;
  /** 少于这么多字的识别结果丢掉:噪声与语气词识别出来常是一两个字 */
  minChars: number;
}

export const PACK_DEFAULTS: PackConfig = {
  joinGapMs: 0,
  maxHoldMs: 8000,
  minChars: 2,
};

/**
 * 识别结果的攒批。`add` 收句子,`due` 到点交货——**时钟由调用方给**,
 * 这样测试不必等真时间,World 也只有一处定时器。
 *
 * `hold` 是这里唯一真正管事的判据:上游(麦克风、转写队列、收尾静音)只要还有一件
 * 没完,批次就按着不动。`hold` 一撤,默认就是立刻发车。
 */
export class Packer {
  private cfg: PackConfig;
  private pieces: string[] = [];
  private firstAt = 0;
  private lastAt = 0;

  constructor(cfg: PackConfig) {
    this.cfg = cfg;
  }

  configure(cfg: PackConfig): void {
    this.cfg = cfg;
  }

  get pending(): boolean {
    return this.pieces.length > 0;
  }

  /** 太短的直接丢,返回 false 表示这句没被收下 */
  add(text: string, atMs: number): boolean {
    const t = text.trim();
    if (t.length < this.cfg.minChars) return false;
    if (this.pieces.length === 0) this.firstAt = atMs;
    this.pieces.push(t);
    this.lastAt = atMs;
    return true;
  }

  /** 到点就把攒着的并成一条交出来；上游仍在收音或转写时继续持有。 */
  due(nowMs: number, hold = false): string | null {
    if (this.pieces.length === 0) return null;
    if (hold) return null;
    const quiet = nowMs - this.lastAt >= this.cfg.joinGapMs;
    const held = nowMs - this.firstAt >= this.cfg.maxHoldMs;
    if (!quiet && !held) return null;
    return this.take();
  }

  /** 当前批最早应再次检查的绝对时刻。 */
  deadline(): number | null {
    if (this.pieces.length === 0) return null;
    return Math.min(this.lastAt + this.cfg.joinGapMs, this.firstAt + this.cfg.maxHoldMs);
  }

  /** 不管到没到点,把攒着的交出来(停止采集、面板要求立刻投递时用) */
  take(): string | null {
    if (this.pieces.length === 0) return null;
    const text = this.pieces.join(' ');
    this.pieces = [];
    return text;
  }
}
