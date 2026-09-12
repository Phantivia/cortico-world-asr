/**
 * AsrWorld — 语音识别接入(worlds-asr)。
 *
 * 定位:**她的耳朵**。麦克风里的话经切分、识别、打包,作为外部事件送进她的
 * 上下文。 World 没有工具——听是纯入站的事,她的表达通道是嘴(worlds-vtuber)或文字,
 * 不在这儿。
 *
 * 一条链路四段,每段都能单独换掉:
 *
 *   声卡(capture.ts) → 切分(segmenter.ts) → 识别(asr-client.ts) → 打包投递
 *
 * 后端只认 OpenAI 兼容的转写端点,自带 FireRedASR2-AED 本地实现,
 * 由 `asr-server.ts` 管起停。换档、换权重、换别的本地实现都不动这一侧。
 *
 * 事件词表(何时唤醒 × 何时成文):
 *   asr.speech   听见有人说话   flush 或 debounce,见 worlds.asr.wake
 *
 * 识别结果**不逐句投递**:人说话是一串短句,逐句唤醒等于把一段话拆成五次打断。
 * 停顿短于收尾静音的相邻句子并成一条;送去转写用的是更短的那一级门限,所以转写跑在
 * 静音窗里而不是排在它后面。详见 segmenter.ts 的两级门限与 Packer。
 */
import { fileURLToPath } from 'node:url';
import type {
  ConfigGroup, World, WorldHost, Logger, WorldConsoleDecl, WorldLamp, WorldPanelDecl,
  WorldStreamSocket, ToolDef,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { AsrClient, looksHallucinated } from './asr-client.ts';
import { AsrServerManager, type AsrProfile, type AsrServerState } from './asr-server.ts';
import { MicCapture, pickDevice, SAMPLE_RATE, type MicDevice } from './capture.ts';
import { Packer, Segmenter, type PackConfig, type SegmentConfig, type Utterance } from './segmenter.ts';
import { applyCorrections, parseCorrections, toSimplified } from './simplify.ts';
import { AsrStream } from './stream.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 随包识别后端目录；models/ 仅保留旧部署回退。 */
const ASR_SERVER_DIR = fileURLToPath(new URL('../runtime/firered-server/', import.meta.url));

/** 一帧的时长:20ms 是电平条跟手与回调开销之间的常用折中 */
const FRAME_MS = 20;
/** 电平与面板状态的推送节拍；转写和打包不依赖这只轮询钟。 */
const TICK_MS = 100;
/** 控制台与 overlay 各留多少条最近文本 */
const RECENT_CAP = 50;
/** 识别失败的告警间隔:后端一死就每句失败一次,原样刷屏会淹掉别的日志 */
const FAIL_WARN_GAP_MS = 60_000;

export const ASR_PANEL_DECLS: readonly WorldPanelDecl[] = [
  { id: 'listen', title: '收听', description: '麦克风、识别后端、电平与实时识别文本。' },
  { id: 'overlay', title: 'Overlay 字幕', description: '推流链接、字幕样式与试显。' },
];

/** overlay 字幕样式;控制台面板改,经装配层回写 config.json,SSE 热推给所有 overlay 页 */
export interface AsrSubtitleStyle {
  /** 字号倍率(0.5–2.5) */
  scale: number;
  /** 字重(100–900) */
  weight: number;
  color: string;
  strokeColor: string;
  /** 描边宽(px,0–4) */
  strokeW: number;
  /** 底板不透明度(0–0.85) */
  plate: number;
  /** CSS font-family;'' = overlay 页默认 */
  fontFamily: string;
}

export interface AsrOverlayConfig {
  /** 画面上同时留几行(1–8) */
  maxLines: number;
  /** 一行停留多久(ms) */
  holdMs: number;
  /** 显示"正在说…"的那一行 */
  showPartial: boolean;
  subtitle: AsrSubtitleStyle;
}

export const ASR_OVERLAY_DEFAULTS: AsrOverlayConfig = {
  maxLines: 2,
  holdMs: 6000,
  showPartial: true,
  subtitle: {
    scale: 1,
    weight: 500,
    color: '#fffef8',
    strokeColor: '#000000',
    strokeW: 1.5,
    plate: 0.35,
    fontFamily: '',
  },
};

export const ASR_DEFAULTS = {
  // enabled 由Persona的装配层显式开启。
  enabled: false,
  /** 麦克风名字子串;空 = 系统默认输入设备 */
  device: '',
  /** World 启动就开始听;关掉则只在控制台按下"开始收听"时听 */
  autoListen: true,
  /** 说话人在事件里怎么称呼。识别不出是谁在说,这就是那个"谁" */
  speaker: '麦克风前的人',
  /** 听见就叫醒她;关掉则排进常规合批 */
  wake: true,
  /**
   * 出口纠错表，每行一条“错=对”，在识别结果中作整段替换；空表不纠错。适用于人名或专有词的固定误识别。
   */
  corrections: '',
  /**
   * 识别流（overlay 页与 SSE）的偏好端口，被占用时顺延。
   */
  streamPort: 7796,
  backend: {
    /** OpenAI 兼容转写端点;自带后端就起在这个端口上 */
    baseUrl: 'http://127.0.0.1:8793/v1',
    /** 只作标签用;本地后端认的是 models/ 里那份权重 */
    model: 'FireRedASR2-AED',
    /** model.pth.tar 的绝对路径;相对路径从运行环境的 models/ 解析 */
    modelFile: '',
    /** 识别结果统一转简体 */
    simplified: true,
    /**
     * World 启动时探测端点，不可达则拉起自带后端；stop() 终止托管后端。
     */
    autoStart: true,
    /** 兼容端点的语言提示;FireRed AED 不强制语言 */
    language: 'zh',
    timeoutMs: 20_000,
    /** 托管本地后端时的档位:gpu = 交给显卡;cpu = 明确关掉显卡 */
    profile: 'gpu' as AsrProfile,
    /** 特征提取与 CPU 推理线程数;0 = 使用 4 线程 */
    threads: 0,
  },
  segment: {
    /** 判为"有人在说"的电平门槛(dBFS) */
    thresholdDb: -42,
    /** 连续超过门槛多久才算开口(ms) */
    minSpeechMs: 180,
    /** 静音多久就把手上这段送去转写(ms);短于收尾静音的那一级 */
    dispatchSilenceMs: 250,
    /** 说完之后静音多久算一句结束(ms) */
    silenceMs: 500,
    /** 一句最长多久强切(ms) */
    maxUtteranceMs: 15_000,
    /** 触发点往前多带一段(ms) */
    preRollMs: 320,
    /** 短于这个的片段直接丢(ms) */
    minUtteranceMs: 350,
  },
  pack: {
    /** 在收尾静音之外还要额外空等多久才发车(ms);并句由切分层的收尾静音管 */
    joinGapMs: 0,
    /** 一条最多攒多久(ms) */
    maxHoldMs: 8000,
    /** 少于这么多字的识别结果丢掉 */
    minChars: 2,
  },
  overlay: ASR_OVERLAY_DEFAULTS,
} as const;

export interface AsrConfigSection {
  enabled: boolean;
  device: string;
  autoListen: boolean;
  speaker: string;
  wake: boolean;
  corrections: string;
  streamPort: number;
  backend: {
    baseUrl: string; model: string; modelFile: string; language: string; simplified: boolean;
    autoStart: boolean; timeoutMs: number; profile: AsrProfile; threads: number;
  };
  segment: SegmentConfig;
  pack: PackConfig;
  overlay: AsrOverlayConfig;
}

export const ASR_CONFIG_GROUP: ConfigGroup = {
  id: 'world:asr',
  owner: 'world:asr',
  schema: {
    type: 'object',
    title: '语音识别 · 接入与后端',
    description:
      '麦克风进来的话经切分与识别送进她的上下文。后端认 OpenAI 兼容的转写端点'
      + '(/audio/transcriptions),自带 FireRedASR2-AED，支持 CUDA 与 CPU，共用模型和 Python 运行环境。'
      + '端口取自端点地址,「收听」面板里那台自带后端就起在那个口上。',
    properties: {
      'worlds.asr.device': {
        type: 'string', title: '麦克风', 'x-hot': true,
        description: '设备名的一段即可(如 "USB Microphone");空 = 系统默认。「收听」面板里可以点着选。',
      },
      'worlds.asr.autoListen': {
        type: 'boolean', title: '启动即收听', 'x-hot': false,
        description: '关掉则 World 只把后端带起来,听不听在面板上按。',
      },
      'worlds.asr.speaker': {
        type: 'string', title: '说话人称呼', 'x-hot': true,
        description: '识别分不出是谁在说,事件里就用这个称呼。',
      },
      'worlds.asr.wake': {
        type: 'boolean', title: '听见就叫醒', 'x-hot': true,
        description: '开着时立即投递，把积压一起带走；关掉则排进常规合批。',
      },
      'worlds.asr.corrections': {
        type: 'string', title: '出口纠错表', 'x-hot': true,
        description: '每条 `错=对`，多条用换行或分号隔开，识别结果里整段替换。'
          + '给人名、圈内词这类按音猜字的固定错法用（如 可提=可缇）；后端的提示词对字形不起作用，只能在出口改。',
      },
      'worlds.asr.streamPort': {
        type: 'integer', title: '识别流端口(偏好)', minimum: 0, maximum: 65535, 'x-hot': false,
        description: '/overlay(字幕页)与 SSE /stream。被占用时自动顺延。',
      },
      'worlds.asr.backend.baseUrl': {
        type: 'string', title: '转写端点', 'x-hot': false,
        description: '形如 http://127.0.0.1:8793/v1。自带后端就起在这个端口上。',
      },
      'worlds.asr.backend.model': { type: 'string', title: '模型名', 'x-hot': true },
      'worlds.asr.backend.modelFile': {
        type: 'string', title: '权重文件', 'x-hot': true,
        description: '选择 FireRedASR2-AED 目录中的 model.pth.tar；同目录须有 cmvn.ark、dict.txt 和 train_bpe1000.model。换权重后重启后端。',
        'x-path': {
          kind: 'file', extensions: ['.tar'],
          recommendedDir: '../../Cortico-Resources/models/asr/FireRedASR2-AED',
        },
        'x-download': {
          href: 'https://huggingface.co/FireRedTeam/FireRedASR2-AED/tree/2304afed56eacfee6256dee5937ed22ffa0b64ec',
          label: 'FireRedASR2-AED 模型文件',
        },
      },
      'worlds.asr.backend.language': {
        type: 'string', title: '语言', enum: ['zh', 'en', 'auto'], 'x-hot': true,
        description: '传给兼容端点的语言提示。FireRed AED 自身识别中英文，不提供强制语言开关。',
      },
      'worlds.asr.backend.simplified': {
        type: 'boolean', title: '中文转简体', 'x-hot': true,
        description: '识别结果统一转为简体；已是简体的文本保持原样。',
      },
      'worlds.asr.backend.autoStart': {
        type: 'boolean', title: '启动时拉起自带后端', 'x-hot': true,
        description: 'World 启动时端点探不通就拉起自带后端；关掉则只在「收听」面板里手动起。'
          + 'World 停止会把托管的后端一起停掉，所以关着它时每次重启都得去面板点一下。',
      },
      'worlds.asr.backend.timeoutMs': {
        type: 'integer', title: '识别超时', minimum: 1000, maximum: 120_000,
        'x-suffix': 's', 'x-scale': 1000, 'x-hot': true,
      },
      'worlds.asr.backend.profile': {
        type: 'string', title: '自带后端档位', enum: ['gpu', 'cpu'], 'x-hot': true,
        description: 'gpu 用 CUDA，cpu 用处理器；两档使用同一份 FireRedASR2-AED 权重。改完需重启后端。',
      },
      'worlds.asr.backend.threads': {
        type: 'integer', title: 'CPU 线程数', minimum: 0, maximum: 128, 'x-hot': true,
        description: '特征提取与 CPU 推理线程数；0 使用 4 线程。改完需重启后端。',
      },
    },
  },
};

export const ASR_SEGMENT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:asr:segment',
  owner: 'world:asr',
  schema: {
    type: 'object',
    title: '语音识别 · 切分与投递',
    description:
      '切分决定"哪一段音频值得送去识别",投递决定"几句话算一次开口"。静音这一侧是两级:'
      + '短的那级只管把音频送去识别,长的那级才决定发车——所以识别耗时是跑在静音窗里的。'
      + '都热改即生效。门槛调不对的两种样子:说了没反应(门槛太高),或者空调声也被送去识别(太低)。'
      + '面板上的电平条读的就是这里的门槛。',
    properties: {
      'worlds.asr.segment.thresholdDb': {
        type: 'integer', title: '说话门槛', minimum: -90, maximum: 0, 'x-suffix': 'dB', 'x-hot': true,
        description: '安静房间的底噪常在 -60 上下,人声峰值在 -20 上下。',
      },
      'worlds.asr.segment.minSpeechMs': {
        type: 'integer', title: '起说时长', minimum: 20, maximum: 2000, 'x-suffix': 'ms', 'x-hot': true,
        description: '连续超过门槛这么久才算开口。咳嗽、键盘、鼠标点击挡在这一关。',
      },
      'worlds.asr.segment.dispatchSilenceMs': {
        type: 'integer', title: '送转写静音', minimum: 40, maximum: 5000, 'x-suffix': 'ms', 'x-hot': true,
        description:
          '停这么久就先把音频送去识别,不等一句判完。转写耗时与音频长短几乎无关,'
          + '早送 = 那段耗时挪进收尾静音里跑。人接着说就自动并回一条,所以这里给短不会切碎句子。'
          + '给到"收尾静音"及以上就退回单级门限。',
      },
      'worlds.asr.segment.silenceMs': {
        type: 'integer', title: '收尾静音', minimum: 100, maximum: 5000, 'x-suffix': 'ms', 'x-hot': true,
        description: '说完之后静音这么久算一句结束,到点才发车。给短了会把一句话拆成两次打断。',
      },
      'worlds.asr.segment.maxUtteranceMs': {
        type: 'integer', title: '单句上限', minimum: 1000, maximum: 60_000, 'x-suffix': 's', 'x-scale': 1000, 'x-hot': true,
        description: '一直说不停时到点强切,免得她等一个人讲完五分钟才听见第一个字。',
      },
      'worlds.asr.segment.preRollMs': {
        type: 'integer', title: '前置回溯', minimum: 0, maximum: 2000, 'x-suffix': 'ms', 'x-hot': true,
        description: '触发点往前多带一段:人开口的第一个字总在能量越线之前。',
      },
      'worlds.asr.segment.minUtteranceMs': {
        type: 'integer', title: '最短片段', minimum: 50, maximum: 5000, 'x-suffix': 'ms', 'x-hot': true,
        description: '短于它的片段不送去识别。',
      },
      'worlds.asr.pack.joinGapMs': {
        type: 'integer', title: '额外等待', minimum: 0, maximum: 10_000, 'x-suffix': 'ms', 'x-hot': true,
        description:
          '转写落地后还要再空等多久才发车。并句由上面的"收尾静音"管,这里是额外加的保险,'
          + '给多少就直接加多少响应延迟。默认 0。',
      },
      'worlds.asr.pack.maxHoldMs': {
        type: 'integer', title: '攒批上限', minimum: 500, maximum: 60_000, 'x-suffix': 's', 'x-scale': 1000, 'x-hot': true,
        description: '一条最多攒这么久,再连着说也要发车。',
      },
      'worlds.asr.pack.minChars': {
        type: 'integer', title: '最少字数', minimum: 1, maximum: 20, 'x-hot': true,
        description: '少于这么多字的识别结果丢掉:噪声与语气词识别出来常是一两个字。',
      },
    },
  },
};

const CSS_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** overlay 配置钳制:数值入界、颜色只收 hex、字体名剥掉能逃出 CSS 声明的字符 */
export function clampOverlay(
  patch: Partial<AsrOverlayConfig> | undefined,
  base: AsrOverlayConfig,
): AsrOverlayConfig {
  const p = patch ?? {};
  const ps: Partial<AsrSubtitleStyle> = p.subtitle ?? {};
  const bs = base.subtitle;
  const color = (v: unknown, fallback: string): string =>
    typeof v === 'string' && CSS_COLOR_RE.test(v) ? v : fallback;
  return {
    maxLines: Math.round(clampNum(p.maxLines, 1, 8, base.maxLines)),
    holdMs: Math.round(clampNum(p.holdMs, 500, 60_000, base.holdMs)),
    showPartial: typeof p.showPartial === 'boolean' ? p.showPartial : base.showPartial,
    subtitle: {
      scale: clampNum(ps.scale, 0.5, 2.5, bs.scale),
      weight: Math.round(clampNum(ps.weight, 100, 900, bs.weight)),
      color: color(ps.color, bs.color),
      strokeColor: color(ps.strokeColor, bs.strokeColor),
      strokeW: clampNum(ps.strokeW, 0, 4, bs.strokeW),
      plate: clampNum(ps.plate, 0, 0.85, bs.plate),
      fontFamily: typeof ps.fontFamily === 'string'
        ? ps.fontFamily.replace(/[;{}<>]/g, '').trim().slice(0, 100)
        : bs.fontFamily,
    },
  };
}

/** 端点地址里的端口;自带后端就起在这个口上 */
export function portOf(baseUrl: string, fallback: number): number {
  try {
    const u = new URL(baseUrl);
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    return fallback;
  }
}

/** 「收听」面板的一份状态 */
export interface AsrListenState {
  listening: boolean;
  /** 声卡通道可用(audify 在、且系统里有输入设备) */
  audioAvailable: boolean;
  devices: MicDevice[];
  /**
   * 配置里钉的那一个(`worlds.asr.device`);空 = 跟随系统默认。
   * 面板的下拉框绑的是**它**,不是下面那个 `device`——两者混成一个的话,
   * "跟随系统默认"与"正好钉住了当前的默认设备"在界面上长得一模一样。
   */
  deviceSetting: string;
  /** 此刻真正在用的设备名(没在听时是按配置解析出来的那个) */
  device: string;
  /** 最近一帧的电平(dBFS) */
  level: number;
  /** 此刻正在收一句 */
  speaking: boolean;
  thresholdDb: number;
  /** 配置里钉的权重文件名;空 = 按档位自动挑(真正加载的那份在 server.model) */
  modelFile: string;
  /** 中文转简体开着没有 */
  simplified: boolean;
  /** 最近的识别结果,新的在前 */
  recent: Array<{ text: string; at: number; ms: number }>;
  /** 已识别句数与已投递条数 */
  counts: { utterances: number; delivered: number; dropped: number };
  server: AsrServerState;
  endpoint: string;
  detail: string | null;
}

/** 「Overlay 字幕」面板的一份状态 */
export interface AsrOverlayState {
  url: string | null;
  streamUp: boolean;
  subscribers: number;
  config: AsrOverlayConfig;
}

interface AsrWorldOptions {
  cfg: AsrConfigSection;
  timezone?: string;
  /** 麦克风改动后回调(装配层写回 config.json) */
  onDevice?: (device: string) => void;
  /** overlay 配置改动后回调(同上) */
  onOverlayConfig?: (config: AsrOverlayConfig) => void;
  /** 权重改动后回调(同上) */
  onModelFile?: (file: string) => void;
  /** 测试注入:替换识别端点客户端 */
  clientOverride?: Pick<AsrClient, 'transcribe'>;
  /** 测试注入:替换声卡采集 */
  captureOverride?: Pick<MicCapture, 'start' | 'stop' | 'running' | 'current' | 'devices'>;
}

export class AsrWorld implements World {
  readonly id = 'asr';

  private host: WorldHost | null = null;
  private readonly cfg: AsrConfigSection;
  private readonly timezone: string;
  private readonly onDevice?: (device: string) => void;
  private readonly onOverlayConfig?: (config: AsrOverlayConfig) => void;
  private readonly onModelFile?: (file: string) => void;
  private readonly server: AsrServerManager;
  private readonly stream: AsrStream;
  private readonly segmenter: Segmenter;
  private readonly packer: Packer;
  private readonly capture: MicCapture;
  private readonly clientOverride?: Pick<AsrClient, 'transcribe'>;
  private overlayCfg: AsrOverlayConfig;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private packTimer: ReturnType<typeof setTimeout> | null = null;
  private packTiming: Pick<PackConfig, 'joinGapMs' | 'maxHoldMs'>;
  private listening = false;
  private detail: string | null = null;
  /** 识别是串行的:一次一句,免得同时几路把本地后端压垮 */
  private transcribing = false;
  private readonly queue: Utterance[] = [];
  private readonly recent: Array<{ text: string; at: number; ms: number }> = [];
  private counts = { utterances: 0, delivered: 0, dropped: 0 };
  /** 识别失败告警的节流基准与窗口内被压掉的条数 */
  private lastFailWarnAt = 0;
  private failWarnSuppressed = 0;
  /** 面板的实时通道 */
  private readonly panelSockets = new Set<WorldStreamSocket>();
  private lastSpeaking = false;
  private readonly fallbackLog: Logger;

  constructor(opts: AsrWorldOptions) {
    this.cfg = opts.cfg;
    this.packTiming = {
      joinGapMs: this.cfg.pack.joinGapMs,
      maxHoldMs: this.cfg.pack.maxHoldMs,
    };
    this.timezone = opts.timezone ?? 'Asia/Shanghai';
    this.onDevice = opts.onDevice;
    this.onOverlayConfig = opts.onOverlayConfig;
    this.onModelFile = opts.onModelFile;
    this.clientOverride = opts.clientOverride;
    this.overlayCfg = clampOverlay(opts.cfg.overlay, ASR_OVERLAY_DEFAULTS);
    // host 挂载在 start();控制台可能在此之前用到后端管理器,日志经转发器现取
    const forward = (get: () => Logger | undefined): Logger => ({
      child: (sub) => forward(() => get()?.child(sub)),
      trace: (m, d) => get()?.trace(m, d),
      debug: (m, d) => get()?.debug(m, d),
      info: (m, d) => get()?.info(m, d),
      warn: (m, d) => get()?.warn(m, d),
      error: (m, d) => get()?.error(m, d),
      emit: (level, m, o) => get()?.emit(level, m, o),
    });
    const fwd = forward(() => this.host?.log);
    this.fallbackLog = fwd;
    this.segmenter = new Segmenter(this.cfg.segment, FRAME_MS);
    this.packer = new Packer(this.cfg.pack);
    this.server = new AsrServerManager({
      serverDir: ASR_SERVER_DIR,
      port: () => portOf(this.cfg.backend.baseUrl, 8793),
      profile: () => this.cfg.backend.profile,
      modelFile: () => this.cfg.backend.modelFile,
      threads: () => this.cfg.backend.threads,
      log: fwd,
    });
    this.stream = new AsrStream({
      preferredPort: this.cfg.streamPort,
      snapshot: () => ({
        overlay: this.overlayCfg,
        recent: [...this.recent].slice(0, this.overlayCfg.maxLines).reverse().map((r) => r.text),
      }),
    });
    this.capture = (opts.captureOverride as MicCapture | undefined) ?? new MicCapture({
      device: () => this.cfg.device,
      frameMs: FRAME_MS,
      onFrame: (frame) => this.onFrame(frame),
      log: fwd,
    });
  }

  /** 模板里的洞只有一个:她听见的是谁。设备与门槛是运维事实,不进前缀。 */
  envPromptVars(): Record<string, string> {
    return { 'asr.speaker': this.cfg.speaker };
  }

  tools(): ToolDef[] {
    return [];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    await this.stream.start(host.log);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    if (this.cfg.autoListen) {
      const err = this.startListening();
      if (err) host.log.warn(`语音识别没能开始收听: ${err}`);
    }
    // stop() 会把托管的后端杀掉,所以每次重启后端点一定是死的:探不通就照配置拉起
    // 自带后端(权重在健康巡检里异步加载,就绪前的句子照常报识别失败)。
    const alive = await this.server.probe();
    if (alive) {
      host.log.info(`语音识别 World 已启动,后端 ${this.cfg.backend.baseUrl} 就绪,字幕页 ${this.stream.overlayUrl}`);
      return;
    }
    if (!this.cfg.backend.autoStart) {
      host.log.warn(
        `语音识别 World 已启动,后端 ${this.cfg.backend.baseUrl} 未就绪(识别会全部失败,去面板拉起后端),字幕页 ${this.stream.overlayUrl}`,
      );
      this.detail = '后端未就绪';
      return;
    }
    const state = await this.server.start();
    if (state.phase === 'error') {
      host.log.warn(
        `语音识别 World 已启动,后端 ${this.cfg.backend.baseUrl} 未就绪,自带后端拉不起来: ${state.detail ?? '原因未知'}(识别会全部失败),字幕页 ${this.stream.overlayUrl}`,
      );
      this.detail = `后端拉不起来: ${state.detail ?? '原因未知'}`;
      return;
    }
    host.log.info(
      `语音识别 World 已启动,后端 ${this.cfg.backend.baseUrl} 未就绪,已拉起自带后端(${state.detail ?? '启动中'}),字幕页 ${this.stream.overlayUrl}`,
    );
    this.detail = '后端启动中';
  }

  async stop(): Promise<void> {
    this.stopListening();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.packTimer) clearTimeout(this.packTimer);
    this.packTimer = null;
    for (const s of [...this.panelSockets]) s.close('World 停止');
    this.panelSockets.clear();
    await this.stream.stop();
    await this.server.stop();
    this.host = null;
  }

  // ---- 采集 → 切分 → 识别 → 投递 -----------------------------------------

  /** 开始收听;返回错误措辞(成功为 null) */
  private startListening(): string | null {
    if (this.listening) return null;
    this.segmenter.configure(this.cfg.segment);
    const err = this.capture.start();
    if (err) {
      this.detail = err;
      return err;
    }
    this.listening = true;
    this.detail = null;
    return null;
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.capture.stop();
    this.listening = false;
    // 手上那半句照样送去识别:人说完最后一句才去按停止是常态
    const tail = this.segmenter.flush();
    if (tail) {
      this.queue.push(tail);
      void this.drainQueue();
    }
    this.flushPackedIfDue();
    this.lastSpeaking = false;
    this.stream.emit('speech', { active: false });
  }

  private onFrame(frame: Int16Array): void {
    const wasHolding = this.segmenter.active || this.segmenter.settleRemainingMs > 0;
    for (const utt of this.segmenter.push(frame)) {
      this.counts.utterances++;
      this.queue.push(utt);
    }
    if (this.queue.length > 0) void this.drainQueue();
    // 收尾静音是按帧数出来的,所以它到点这条边也从帧上取——flushPackedIfDue 里那只钟
    // 走的是墙钟,只在帧不来了(声卡卡住)时兜底。
    if (wasHolding && !this.segmenter.active && this.segmenter.settleRemainingMs === 0) {
      this.flushPackedIfDue();
    }
  }

  /** 节拍只推电平与状态；音频帧和转写落地各自推进流水线。 */
  private tick(): void {
    this.segmenter.configure(this.cfg.segment);
    const packTimingChanged = this.configurePacker();
    const speaking = this.listening && this.segmenter.active;
    if (speaking !== this.lastSpeaking) {
      this.lastSpeaking = speaking;
      this.stream.emit('speech', { active: speaking });
    }
    this.toPanels({
      type: 'level',
      level: this.listening ? this.segmenter.level : -100,
      speaking,
      listening: this.listening,
    });
    void this.drainQueue();
    if (packTimingChanged) this.flushPackedIfDue();
  }

  private async drainQueue(): Promise<void> {
    if (this.transcribing) return;
    const utt = this.queue.shift();
    if (!utt) return;
    this.transcribing = true;
    try {
      const res = await this.client().transcribe(utt.pcm, SAMPLE_RATE);
      if (res.error) {
        this.detail = `识别失败: ${res.error}`;
        this.counts.dropped++;
        this.warnTranscribeFailed(res.error);
        return;
      }
      this.detail = null;
      // 先定字形再过滤:幻觉名单是按简体写的,繁体的"謝謝觀看"得先变成简体才认得出
      const heard = this.cfg.backend.simplified ? toSimplified(res.text) : res.text;
      if (looksHallucinated(heard)) {
        // 纯噪声上 whisper 会稳定吐出训练集里的高频片段;放过去她会当真去回应
        this.counts.dropped++;
        this.toPanels({ type: 'dropped', text: heard, ms: res.ms });
        return;
      }
      const text = applyCorrections(heard, parseCorrections(this.cfg.corrections));
      this.note(text, res.ms);
      if (!this.packer.add(text, Date.now())) this.counts.dropped++;
    } finally {
      this.transcribing = false;
      void this.drainQueue();
      this.flushPackedIfDue();
    }
  }

  /** 麦克风与转写流水线空闲后按精确 deadline 发车。 */
  private flushPackedIfDue(): void {
    if (this.packTimer) clearTimeout(this.packTimer);
    this.packTimer = null;
    this.configurePacker();
    // 收尾静音是三条持有里唯一有确定到点时刻的:另外两条各自会在自己完事时再叫一次,
    // 它得自己下钟——短门限已经把音频交出去了,这一段的最后一个帧回调可能早就过去了。
    const settleMs = this.segmenter.settleRemainingMs;
    const busy = this.segmenter.active || this.transcribing || this.queue.length > 0;
    const due = this.packer.due(Date.now(), busy || settleMs > 0);
    if (due) {
      void this.deliver(due);
      return;
    }
    const at = this.packer.deadline();
    if (at === null || busy) return;
    const wake = Math.max(at, Date.now() + settleMs);
    this.packTimer = setTimeout(() => {
      this.packTimer = null;
      this.flushPackedIfDue();
    }, Math.max(0, wake - Date.now()));
  }

  /** 热配置缩短 deadline 时立即重排；minChars 仍随每次配置同步生效。 */
  private configurePacker(): boolean {
    const next = {
      joinGapMs: this.cfg.pack.joinGapMs,
      maxHoldMs: this.cfg.pack.maxHoldMs,
    };
    const timingChanged =
      next.joinGapMs !== this.packTiming.joinGapMs ||
      next.maxHoldMs !== this.packTiming.maxHoldMs;
    this.packTiming = next;
    this.packer.configure(this.cfg.pack);
    return timingChanged;
  }

  /**
   * 识别失败的告警:每 FAIL_WARN_GAP_MS 至多一条,窗口内被压掉的条数与累计丢弃数随文案带出。
   * 节流不等于静默——后端死一整场时,人要能从任意一条日志里看出丢了多少句。
   */
  private warnTranscribeFailed(error: string): void {
    const now = Date.now();
    if (now - this.lastFailWarnAt < FAIL_WARN_GAP_MS) {
      this.failWarnSuppressed++;
      return;
    }
    const same = this.failWarnSuppressed > 0 ? `,此前 ${this.failWarnSuppressed} 条同类未记` : '';
    this.lastFailWarnAt = now;
    this.failWarnSuppressed = 0;
    this.host?.log.warn(`语音识别失败: ${error}(累计丢弃 ${this.counts.dropped} 句${same})`);
  }

  /** 一条投递:走 pushEvent 那唯一的通道,外部事件 */
  private async deliver(text: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    this.counts.delivered++;
    await host
      .pushEvent(
        {
          ts: nowIso(this.timezone),
          source: this.id,
          type: 'asr.speech',
          text: `[语音] ${this.cfg.speaker}:${text}`,
          senderKey: `asr:${this.cfg.speaker}`,
        },
        { trigger: this.cfg.wake ? 'flush' : 'debounce' },
      )
      .catch((e) => host.log.warn('语音事件投递失败', { err: String(e) }));
  }

  /** 一句识别结果:进最近表、上字幕、给面板 */
  private note(text: string, ms: number): void {
    const at = Date.now();
    this.recent.unshift({ text, at, ms });
    while (this.recent.length > RECENT_CAP) this.recent.pop();
    this.stream.emit('text', { text, at, ms });
    this.toPanels({ type: 'text', text, at, ms });
  }

  private client(): Pick<AsrClient, 'transcribe'> {
    if (this.clientOverride) return this.clientOverride;
    const b = this.cfg.backend;
    return new AsrClient({
      baseUrl: b.baseUrl,
      model: b.model,
      language: b.language,
      timeoutMs: b.timeoutMs,
    });
  }

  private toPanels(frame: Record<string, unknown>): void {
    if (this.panelSockets.size === 0) return;
    const payload = JSON.stringify(frame);
    for (const s of this.panelSockets) s.send(payload);
  }

  // ---- 控制台 -------------------------------------------------------------

  /**
   * 三条链路各一颗:麦、识别后端、字幕页。
   *
   * 分开点是因为它们坏起来互不相干——后端挂了麦照样在收(只是没人翻译),
   * 字幕页没起不影响听见。一颗聚合灯只能报最坏的那条,看的人还得自己去猜是哪条。
   */
  private lamps(): WorldLamp[] {
    const phase = this.server.currentPhase;
    return [
      {
        label: '麦克风',
        ...(this.listening
          ? this.detail
            ? { state: 'error' as const, hint: this.detail }
            : { state: 'online' as const, hint: this.capture.current?.name ?? '收听中' }
          : { state: 'offline' as const, hint: '未开始收听' }),
      },
      {
        label: '识别后端',
        ...(phase === 'error'
          ? { state: 'error' as const, hint: this.detail ?? '起不来' }
          : phase === 'starting'
            ? { state: 'loading' as const, hint: '启动中' }
            : phase === 'running'
              ? { state: 'online' as const }
              : { state: 'offline' as const, hint: '未启动' }),
      },
      {
        label: '字幕页',
        ...(this.stream.up
          ? { state: 'online' as const, hint: `:${this.stream.port}` }
          : { state: 'offline' as const, hint: '未启动' }),
      },
    ];
  }

  console(): WorldConsoleDecl {
    const last = this.recent[0];
    return {
      lamps: this.lamps(),
      badges: [
        {
          label: '收听',
          value: this.listening ? (this.capture.current?.name ?? '进行中') : '未开始',
          tone: this.listening ? 'on' : 'off',
        },
        {
          label: '最近听到',
          value: last ? last.text.slice(0, 18) : '—',
          tone: last ? 'plain' : 'off',
        },
        {
          label: '字幕页',
          value: this.stream.up ? `:${this.stream.port}` : '未启动',
          tone: this.stream.up ? 'on' : 'off',
        },
      ],
      panels: [...ASR_PANEL_DECLS],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      stream: (panel, socket) => {
        if (panel !== 'listen') {
          socket.close(`未知面板流: ${panel}`);
          return;
        }
        this.panelSockets.add(socket);
        socket.onClose(() => this.panelSockets.delete(socket));
      },
      promptDocs: [
        {
          key: 'worlds.asr.envPrompt',
          title: '语音识别 · 环境提示词',
          description: '"她听得见"这件事的常驻事实。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'asr.speaker', description: '事件里对说话人的称呼(worlds.asr.speaker)。' }],
        },
      ],
      links: this.stream.up ? [{ label: '打开字幕页', href: this.stream.overlayUrl }] : [],
      config: [ASR_CONFIG_GROUP, ASR_SEGMENT_CONFIG_GROUP],
    };
  }

  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'listen') {
      switch (method) {
        case 'state': return this.listenState();
        case 'start': {
          const err = this.startListening();
          return this.listenState(err ?? '开始收听');
        }
        case 'stop': {
          this.stopListening();
          return this.listenState('已停止收听');
        }
        case 'setDevice': {
          const name = typeof args[0] === 'string' ? args[0] : '';
          this.cfg.device = name;
          this.onDevice?.(name);
          if (this.listening) {
            // 设备是开流那一刻定的,换设备就得重开一次
            this.capture.stop();
            this.listening = false;
            const err = this.startListening();
            const now = this.capture.current?.name ?? (name || '系统默认');
            return this.listenState(err ?? `已切到「${now}」`);
          }
          return this.listenState(`下次收听用「${name || '系统默认'}」`);
        }
        case 'setModel': {
          const file = typeof args[0] === 'string' ? args[0] : '';
          this.cfg.backend.modelFile = file;
          this.onModelFile?.(file);
          // 权重是启动时加载的,跑着就得重起一次才算换过去
          const wasUp = (await this.server.state()).pid !== null;
          if (wasUp) {
            await this.server.stop();
            await this.server.start();
            return this.listenState(`换成「${file || '自动'}」并重启了后端`);
          }
          return this.listenState(`下次启动后端用「${file || '自动'}」`);
        }
        case 'clear': {
          this.recent.length = 0;
          this.counts = { utterances: 0, delivered: 0, dropped: 0 };
          return this.listenState('已清空');
        }
        case 'server.start': return this.server.start();
        case 'server.stop': return this.server.stop();
        case 'server.state': return this.server.state();
        default: throw new Error(`未知面板方法: ${panel}.${method}`);
      }
    }
    if (panel === 'overlay') {
      switch (method) {
        case 'state': return this.overlayState();
        case 'setConfig': {
          this.overlayCfg = clampOverlay(args[0] as Partial<AsrOverlayConfig>, this.overlayCfg);
          this.cfg.overlay = this.overlayCfg;
          this.stream.emit('overlay.config', { config: this.overlayCfg });
          this.onOverlayConfig?.(this.overlayCfg);
          return this.overlayState();
        }
        case 'test': {
          const text = typeof args[0] === 'string' && args[0].trim() ? args[0].trim() : '这是一条试显字幕';
          this.stream.emit('text', { text, at: Date.now(), ms: 0 });
          return this.overlayState();
        }
        default: throw new Error(`未知面板方法: ${panel}.${method}`);
      }
    }
    throw new Error(`未知面板: ${panel}`);
  }

  private async listenState(detail?: string): Promise<AsrListenState> {
    const devices = this.capture.devices();
    const picked = this.capture.current ?? pickDevice(devices, this.cfg.device);
    return {
      listening: this.listening,
      audioAvailable: devices.length > 0,
      devices,
      deviceSetting: this.cfg.device,
      device: picked?.name ?? '',
      level: this.listening ? this.segmenter.level : -100,
      speaking: this.listening && this.segmenter.active,
      thresholdDb: this.cfg.segment.thresholdDb,
      modelFile: this.cfg.backend.modelFile,
      simplified: this.cfg.backend.simplified,
      recent: [...this.recent],
      counts: { ...this.counts },
      server: await this.server.state(),
      endpoint: `${this.cfg.backend.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
      detail: detail ?? this.detail,
    };
  }

  private overlayState(): AsrOverlayState {
    return {
      url: this.stream.up ? this.stream.overlayUrl : null,
      streamUp: this.stream.up,
      subscribers: this.stream.subscriberCount,
      config: this.overlayCfg,
    };
  }
}
