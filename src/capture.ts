/**
 * 麦克风采集:RtAudio(WASAPI/CoreAudio/ALSA)按帧读 16-bit 单声道 PCM。
 *
 * 与 worlds-vtuber 的输出通道同一个原生模块、同一条"Windows 上钉死 WASAPI"的理由:
 * RtAudio 自选后端时在 Windows 上优先 ASIO,而装了厂商 ASIO 驱动的机器上设备表
 * 只剩一个 "Realtek ASIO",驱动按自己的缓冲区大小工作、不认请求的帧长,第一次
 * 读写就写越界打死进程。WASAPI 枚举的是系统设备表,虚拟声卡也在里面。
 *
 * 采样率固定 16k:语音识别模型全部按 16k 训练,声卡直接给这个率就省掉一次重采样。
 * 设备不支持时由 RtAudio 自己转。
 */
import { createRequire } from 'node:module';
import type { Logger } from 'cortico/core/types.ts';

/** 识别模型的输入采样率 */
export const SAMPLE_RATE = 16_000;

export interface MicDevice {
  id: number;
  name: string;
  /** 该设备的最大输入通道数 */
  channels: number;
  isDefault: boolean;
}

interface RtAudioLike {
  openStream(
    out: null,
    input: { deviceId: number; nChannels: number; firstChannel: number },
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: (data: Buffer) => void,
    frameOutputCallback: null,
  ): number;
  closeStream(): void;
  start(): void;
  stop(): void;
  isStreamOpen(): boolean;
  getDevices(): Array<{ id: number; name: string; inputChannels: number; isDefaultInput: number }>;
  getDefaultInputDevice(): number;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number };
}

function loadAudify(log: Logger): AudifyModule | null {
  try {
    return createRequire(import.meta.url)('audify') as AudifyModule;
  } catch (err) {
    log.warn(`audify 加载失败,麦克风不可用: ${(err as Error).message}`);
    return null;
  }
}

function makeRt(audify: AudifyModule): RtAudioLike {
  return new audify.RtAudio(
    process.platform === 'win32' ? audify.RtAudioApi.WINDOWS_WASAPI : undefined,
  );
}

/** 系统里的输入设备。audify 不在时给空表(面板据此显示"声卡不可用")。 */
export function listInputDevices(log: Logger, audifyOverride?: AudifyModule): MicDevice[] {
  const audify = audifyOverride ?? loadAudify(log);
  if (!audify) return [];
  try {
    const rt = makeRt(audify);
    const def = rt.getDefaultInputDevice();
    return rt.getDevices()
      .filter((d) => d.inputChannels > 0)
      .map((d) => ({
        id: d.id,
        name: d.name,
        channels: d.inputChannels,
        isDefault: d.id === def || d.isDefaultInput === 1,
      }));
  } catch (err) {
    log.warn(`枚举输入设备失败: ${(err as Error).message}`);
    return [];
  }
}

/** 名字子串 → 设备 id;`''` 取系统默认,匹配不到也退回默认 */
export function pickDevice(devices: MicDevice[], want: string): MicDevice | null {
  if (devices.length === 0) return null;
  const key = want.trim().toLowerCase();
  if (key) {
    const hit = devices.find((d) => d.name.toLowerCase().includes(key));
    if (hit) return hit;
  }
  return devices.find((d) => d.isDefault) ?? devices[0];
}

interface MicCaptureOptions {
  /** 设备名子串;空 = 系统默认。现读,重开流才生效 */
  device: () => string;
  /** 一帧多少毫秒;越小电平条越跟手,越大回调越省 */
  frameMs: number;
  /** 每帧一次,单声道 16-bit 样本(多声道设备只取第一声道) */
  onFrame: (frame: Int16Array) => void;
  log: Logger;
  /** 测试注入:替换原生模块 */
  audifyOverride?: AudifyModule;
}

/**
 * 一路输入流。`start` 返回错误措辞(成功为 null)——采集失败是控制台要显示的
 * 事实,不是异常路径。
 */
export class MicCapture {
  private rt: RtAudioLike | null = null;
  private device: MicDevice | null = null;
  private frames = 0;

  constructor(private readonly opts: MicCaptureOptions) {}

  get running(): boolean {
    return this.rt !== null;
  }

  /** 当前实际用着的设备;没开流为 null */
  get current(): MicDevice | null {
    return this.device;
  }

  /** 已读到的帧数;用来判断"开着流但一帧都没来"(设备被独占) */
  get frameCount(): number {
    return this.frames;
  }

  /**
   * 系统里的输入设备。走这条路而不是直接调 `listInputDevices`,替身才顶得住:
   * 那个 .node 一旦进了 worker 线程,线程收工时它的 napi 清理会打死整个进程。
   */
  devices(): MicDevice[] {
    return listInputDevices(this.opts.log, this.opts.audifyOverride);
  }

  start(): string | null {
    if (this.rt) return null;
    const audify = this.opts.audifyOverride ?? loadAudify(this.opts.log);
    if (!audify) return 'audify 原生模块加载失败:本机没有可用声卡通道';
    const devices = listInputDevices(this.opts.log, audify);
    const picked = pickDevice(devices, this.opts.device());
    if (!picked) return '系统里没有可用的录音设备';
    const frameSize = Math.round((SAMPLE_RATE * this.opts.frameMs) / 1000);
    try {
      const rt = makeRt(audify);
      rt.openStream(
        null,
        { deviceId: picked.id, nChannels: 1, firstChannel: 0 },
        audify.RtAudioFormat.RTAUDIO_SINT16,
        SAMPLE_RATE,
        frameSize,
        'cortico-asr',
        (data: Buffer) => {
          this.frames++;
          this.opts.onFrame(new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1));
        },
        null,
      );
      rt.start();
      this.rt = rt;
      this.device = picked;
      this.frames = 0;
      this.opts.log.info(`麦克风已打开: ${picked.name}(${SAMPLE_RATE}Hz 单声道)`);
      return null;
    } catch (err) {
      this.rt = null;
      this.device = null;
      return `打开麦克风失败(${picked.name}): ${(err as Error).message}`;
    }
  }

  stop(): void {
    const rt = this.rt;
    this.rt = null;
    this.device = null;
    if (!rt) return;
    try {
      rt.stop();
      rt.closeStream();
      this.opts.log.info('麦克风已关闭');
    } catch (err) {
      this.opts.log.warn(`关闭麦克风出错: ${(err as Error).message}`);
    }
  }
}
