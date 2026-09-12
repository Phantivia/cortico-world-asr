/**
 * 语音识别 World 的浏览器扩展 —— 收听 / Overlay 字幕 两个面板。
 *
 * 这个文件只做装配与共享类型;面板本体各在自己的文件里。与外界的依赖只有
 * `client-panel.ts` 的类型:数据面一律走 `ctx.invoke`,实时数据走 `ctx.stream`,
 * DOM 一律用 `ctx.ui` 原语,定时器一律 `ctx.interval`。
 *
 * `style.css` 是本 provider 自己的样式,只放 `ctx.ui` 没有对应原语的那两块
 * (电平条、字幕预览框),用 `asr-` 前缀避开控制台的通用 class。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
} from 'cortico/web/shared/client-panel.ts';
import './style.css';
import { listenPanel } from './listen.ts';
import { overlayPanel } from './overlay.ts';

// ---------------------------------------------------------------------------
// 共享类型:服务端 `AsrWorld.invokePanel` 各方法的返回形状
// ---------------------------------------------------------------------------

interface AsrMicDevice {
  id: number;
  name: string;
  channels: number;
  isDefault: boolean;
}

export interface AsrServerState {
  phase: string;
  url: string;
  detail: string | null;
  pid: number | null;
  reachable: boolean;
  model: string | null;
  profile: string;
  /** 这一档的二进制在不在位 */
  installed: boolean;
  /** models/ 下所有权重 */
  models: string[];
}

/** `listen.state` */
export interface AsrListenState {
  listening: boolean;
  audioAvailable: boolean;
  devices: AsrMicDevice[];
  /** 配置里钉的那个;空 = 跟随系统默认 */
  deviceSetting: string;
  /** 此刻真正在用的设备名 */
  device: string;
  /** 最近一帧的电平(dBFS) */
  level: number;
  speaking: boolean;
  thresholdDb: number;
  /** 配置里钉的权重文件名;空 = 自动挑 */
  modelFile: string;
  simplified: boolean;
  recent: Array<{ text: string; at: number; ms: number }>;
  counts: { utterances: number; delivered: number; dropped: number };
  server: AsrServerState;
  endpoint: string;
  detail: string | null;
}

export interface AsrSubtitleStyle {
  scale: number;
  weight: number;
  color: string;
  strokeColor: string;
  strokeW: number;
  plate: number;
  fontFamily: string;
}

export interface AsrOverlayConfig {
  maxLines: number;
  holdMs: number;
  showPartial: boolean;
  subtitle: AsrSubtitleStyle;
}

/** `overlay.state` */
export interface AsrOverlayState {
  url: string | null;
  streamUp: boolean;
  subscribers: number;
  config: AsrOverlayConfig;
}

/** `listen` 的实时通道推的帧 */
export type AsrPanelFrame =
  | { type: 'level'; level: number; speaking: boolean; listening: boolean }
  | { type: 'text'; text: string; at: number; ms: number }
  | { type: 'dropped'; text: string; ms: number };

// ---------------------------------------------------------------------------
// 共享 helper
// ---------------------------------------------------------------------------

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AsrMsgLine {
  el: HTMLDivElement;
  say(text?: string | null, bad?: boolean): void;
}

export function msgLine(ctx: ConsolePanelContext, cls?: string): AsrMsgLine {
  const el = ctx.ui.msgline('');
  if (cls) el.classList.add(cls);
  return {
    el,
    say(text, bad) {
      el.textContent = text ?? '';
      el.classList.toggle('bad', bad === true);
    },
  };
}

// ---------------------------------------------------------------------------

const bundle: ConsoleClientBundle = {
  panels: {
    listen: listenPanel,
    overlay: overlayPanel,
  },
};

export default bundle;
