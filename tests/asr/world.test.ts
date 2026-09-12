/**
 * AsrWorld:声卡 → 切分 → 识别 → 打包投递这条链,以及控制台面板。
 *
 * 声卡与识别端点都由注入替身顶掉——前者本机不一定有,后者要真跑一台 whisper。
 * 替身之外的每一段(切分、幻觉过滤、攒批、投递口径、面板状态)都是真代码。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AsrWorld, ASR_DEFAULTS, clampOverlay, portOf,
  type AsrConfigSection, type AsrListenState, type AsrOverlayState,
} from '../../src/world.ts';
import { ASR_OVERLAY_DEFAULTS } from '../../src/world.ts';
import { FakeHost } from '../helpers/fake-host.ts';

function cfg(over: Partial<AsrConfigSection> = {}): AsrConfigSection {
  return structuredClone({ ...ASR_DEFAULTS, enabled: true, ...over }) as AsrConfigSection;
}

const RATE = 16_000;
const FRAME = new Int16Array(320); // 20ms

/** 一帧人声档正弦(约 -13 dBFS) */
function loud(): Int16Array {
  const f = new Int16Array(320);
  for (let i = 0; i < f.length; i++) f[i] = Math.round(Math.sin((i / RATE) * 2 * Math.PI * 220) * 0.3 * 32767);
  return f;
}

/**
 * 假声卡:握着 World 给的 onFrame,测试自己决定什么时候有声音。
 * `streamPort: 0` 让识别流挑一个随机空闲口,测试之间不打架。
 */
function rig(over: Partial<AsrConfigSection> = {}, transcripts: string[] = ['听得见吗']) {
  // autoStart 默认关:测试机上要是真有权重,World 启动会去 spawn 一台 whisper-server
  const config = cfg({
    streamPort: 0,
    autoListen: false,
    ...over,
    backend: { ...ASR_DEFAULTS.backend, autoStart: false, ...(over.backend ?? {}) },
  });
  let onFrame: ((f: Int16Array) => void) | null = null;
  const capture = {
    running: false,
    current: { id: 1, name: '假麦克风', channels: 1, isDefault: true },
    devices: () => (capture.current ? [capture.current] : []),
    start: () => { capture.running = true; return null; },
    stop: () => { capture.running = false; },
  };
  let take = 0;
  const transcribe = vi.fn(async () => ({
    text: transcripts[Math.min(take++, transcripts.length - 1)],
    ms: 42,
    error: null as string | null,
  }));
  const m = new AsrWorld({
    cfg: config,
    captureOverride: capture as never,
    clientOverride: { transcribe },
  });
  // 采集替身没有真回调,把 World 的 onFrame 借出来
  onFrame = (f: Int16Array) => (m as any).onFrame(f);
  const speak = (ms: number, frame: Int16Array): void => {
    for (let t = 0; t < ms; t += 20) onFrame!(frame);
  };
  const tick = (): void => (m as any).tick();
  const invoke = (panel: string, method: string, args: unknown[] = []): Promise<unknown> =>
    (m as any).invokePanel(panel, method, args);
  return { m, config, capture, transcribe, speak, tick, invoke };
}

/** 让排队的识别真正跑完:drainQueue 是异步的,tick 只负责催 */
async function settle(tick: () => void, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    tick();
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('World 面', () => {
  it('没有工具:听是纯入站的事', () => {
    expect(new AsrWorld({ cfg: cfg() }).tools()).toEqual([]);
  });

  it('环境提示词的洞只有"她听见的是谁"', () => {
    const m = new AsrWorld({ cfg: cfg({ speaker: '老板' }) });
    expect(m.envPromptVars()).toEqual({ 'asr.speaker': '老板' });
  });

  it('面板声明是局部 id + 真标题', () => {
    const decl = new AsrWorld({ cfg: cfg() }).console();
    expect(decl.panels?.map((p) => p.id)).toEqual(['listen', 'overlay']);
    for (const p of decl.panels ?? []) expect(p.description).toBeTruthy();
    expect(decl.config?.map((g) => g.id)).toEqual(['world:asr', 'world:asr:segment']);
    for (const g of decl.config ?? []) expect(g.owner).toBe('world:asr');
  });

  it('声明的每个配置键都能在默认值里找到落点', () => {
    const decl = new AsrWorld({ cfg: cfg() }).console();
    for (const group of decl.config ?? []) {
      for (const key of Object.keys(group.schema.properties)) {
        const path = key.split('.').slice(1); // 去掉 worlds. 前缀
        let node: unknown = { asr: cfg() };
        for (const seg of path) node = (node as Record<string, unknown>)[seg];
        expect(node, key).not.toBeUndefined();
      }
    }
  });
});

describe('一条链:说话 → 识别 → 投递', () => {
  it('说一句停下来:识别一次,攒批到点投一条外部事件', async () => {
    const { m, transcribe, speak, tick, invoke } = rig({ pack: { joinGapMs: 0, maxHoldMs: 8000, minChars: 2 } });
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(host.events).toHaveLength(1);
    expect(host.events[0].type).toBe('asr.speech');
    expect(host.events[0].text).toBe(`[语音] ${ASR_DEFAULTS.speaker}:听得见吗`);
    expect(host.pushOpts[0]).toMatchObject({ trigger: 'flush' });
    await m.stop();
  });

  it('关掉"听见就叫醒"就排进常规合批', async () => {
    const { m, speak, tick, invoke } = rig({ wake: false, pack: { joinGapMs: 0, maxHoldMs: 8000, minChars: 2 } });
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(host.pushOpts[0]).toMatchObject({ trigger: 'debounce' });
    await m.stop();
  });

  it('短门限先送去转写,长门限才发车:识别耗时跑在收尾静音里', async () => {
    const { m, transcribe, speak, tick, invoke } = rig();
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(600, loud());
    speak(300, FRAME); // 过了送转写门限(250),没到收尾静音(500)
    await settle(tick);
    expect(transcribe).toHaveBeenCalledTimes(1); // 音频已经交出去识别了
    expect(host.events).toHaveLength(0); // 但这一段还没算说完
    speak(260, FRAME); // 补满收尾静音:结果早就回来了,发车即刻
    await new Promise((r) => setTimeout(r, 20));
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('听得见吗');
    await m.stop();
  });

  it('停顿短于收尾静音的两句仍并成一条:并句不再靠额外等待', async () => {
    const { m, transcribe, speak, invoke } = rig({}, ['今天天气不错', '要不要出去走走']);
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(600, loud());
    speak(300, FRAME); // 停 300ms:过了送转写门限,没到收尾静音
    await new Promise((r) => setTimeout(r, 30)); // 前半句的转写在这段静音里跑完
    speak(600, loud());
    speak(700, FRAME);
    await new Promise((r) => setTimeout(r, 40));
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('今天天气不错 要不要出去走走');
    await m.stop();
  });

  it('停顿长于收尾静音就是两次开口:各自发车,后到的由总线下一批收拢', async () => {
    const { m, speak, invoke } = rig({}, ['前半句已经说完', '后半句接着说']);
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(600, loud());
    speak(700, FRAME); // 过了收尾静音
    await new Promise((r) => setTimeout(r, 30));
    expect(host.events).toHaveLength(1);
    speak(600, loud());
    speak(700, FRAME);
    await new Promise((r) => setTimeout(r, 30));
    expect(host.events).toHaveLength(2);
    expect(host.pushOpts.every((o) => o?.trigger === 'flush')).toBe(true);
    await m.stop();
  });

  it('连着说的两句并成一条,不是两次打断', async () => {
    // 并句窗口给 300ms:两句都识别完了窗口还没到,所以这一条必须是"并"出来的
    const { m, transcribe, speak, tick, invoke } = rig(
      { pack: { joinGapMs: 300, maxHoldMs: 8000, minChars: 2 } },
      ['今天天气不错', '要不要出去走走'],
    );
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(600, loud());
    speak(800, FRAME);
    speak(600, loud());
    speak(800, FRAME);
    await settle(tick, 6);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(host.events).toHaveLength(0); // 还在窗口里:一条都没发出去
    await new Promise((r) => setTimeout(r, 350));
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('今天天气不错 要不要出去走走');
    await m.stop();
  });

  it('下一句已经开口时不发前半句，等转写队列清空后合并', async () => {
    const { m, speak, invoke } = rig(
      { pack: { joinGapMs: 300, maxHoldMs: 8000, minChars: 2 } },
      ['前半句已经说完', '后半句接着说'],
    );
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(600, loud());
    speak(600, FRAME);
    await new Promise((r) => setTimeout(r, 20));
    speak(300, loud());
    await new Promise((r) => setTimeout(r, 350));
    expect(host.events).toHaveLength(0);
    speak(400, loud());
    speak(600, FRAME);
    await new Promise((r) => setTimeout(r, 350));
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('前半句已经说完 后半句接着说');
    await m.stop();
  });

  it('待发批次缩短并句窗口后立即按新 deadline 发车', async () => {
    const { m, config, speak, tick, invoke } = rig(
      { pack: { joinGapMs: 5000, maxHoldMs: 8000, minChars: 2 } },
      ['热改前已经识别'],
    );
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(600, loud());
    speak(600, FRAME);
    await settle(tick);
    expect(host.events).toHaveLength(0);

    config.pack.joinGapMs = 0;
    tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('热改前已经识别');
    await m.stop();
  });

  it('定时器在收音时到点且停止时短片段被丢弃，旧批次仍会发车', async () => {
    const { m, config, transcribe, speak, tick, invoke } = rig(
      { pack: { joinGapMs: 5000, maxHoldMs: 8000, minChars: 2 } },
      ['旧批次'],
    );
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(600, loud());
    speak(600, FRAME);
    await settle(tick);

    // 上一句的钟在 active 期间到点；280ms 的新片段短于默认 minUtteranceMs=350。
    speak(180, loud());
    expect((m as any).segmenter.active).toBe(true);
    config.pack.joinGapMs = 0;
    (m as any).flushPackedIfDue();
    expect(host.events).toHaveLength(0);
    await invoke('listen', 'stop');
    await new Promise((r) => setTimeout(r, 10));

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(host.events).toHaveLength(1);
    expect(host.events[0].text).toContain('旧批次');
    await m.stop();
  });

  it('疑似幻觉的识别结果不投递,但在面板上标出来', async () => {
    const { m, speak, tick, invoke } = rig({}, ['字幕由 Amara.org 社区提供']);
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(host.events).toHaveLength(0);
    const st = await invoke('listen', 'state') as AsrListenState;
    expect(st.counts.utterances).toBe(1);
    expect(st.counts.dropped).toBe(1);
    expect(st.counts.delivered).toBe(0);
    await m.stop();
  });

  it('识别失败照实说,不投一条空话', async () => {
    const { m, speak, tick, invoke } = rig();
    (m as any).clientOverride = { transcribe: async () => ({ text: '', ms: 3, error: '识别超时(20000ms)' }) };
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(host.events).toHaveLength(0);
    const st = await invoke('listen', 'state') as AsrListenState;
    expect(st.detail).toContain('识别超时');
    await m.stop();
  });

  // start() 从不拉起后端(只有面板与 setModel 会),stop() 却会杀掉它:core 重启一次,
  // 就变成麦克风在收、后端已死,而控制台仍显示已启动。
  it('关掉自动拉起:启动时探不通就 warn,并把「后端未就绪」摆到面板上', async () => {
    const { m, invoke } = rig({ backend: { ...ASR_DEFAULTS.backend, baseUrl: 'http://127.0.0.1:1/v1', autoStart: false } });
    const host = new FakeHost();
    const logs: Array<{ level: string; msg: string }> = [];
    const rec = {
      child: () => rec,
      emit: (level: string, msg: string) => logs.push({ level, msg }),
      trace: (msg: string) => logs.push({ level: 'trace', msg }),
      debug: (msg: string) => logs.push({ level: 'debug', msg }),
      info: (msg: string) => logs.push({ level: 'info', msg }),
      warn: (msg: string) => logs.push({ level: 'warn', msg }),
      error: (msg: string) => logs.push({ level: 'error', msg }),
    };
    host.log = rec as never;
    await m.start(host);
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('未就绪'))).toBe(true);
    const st = await invoke('listen', 'state') as AsrListenState;
    expect(st.detail).toBe('后端未就绪');
    await m.stop();
  });

  it('自动拉起:探不通就起自带后端,起不来把原因摆到日志与面板上', async () => {
    const { m, invoke } = rig({
      backend: {
        ...ASR_DEFAULTS.backend,
        baseUrl: 'http://127.0.0.1:1/v1',
        autoStart: true,
        // 绝对路径且不存在:launch 解析在 spawn 之前就失败,测试机上不会真起一台 whisper
        modelFile: 'C:\\nowhere\\ggml-none.bin',
      },
    });
    const host = new FakeHost();
    const logs: Array<{ level: string; msg: string }> = [];
    const rec = {
      child: () => rec,
      emit: (level: string, msg: string) => logs.push({ level, msg }),
      trace: (msg: string) => logs.push({ level: 'trace', msg }),
      debug: (msg: string) => logs.push({ level: 'debug', msg }),
      info: (msg: string) => logs.push({ level: 'info', msg }),
      warn: (msg: string) => logs.push({ level: 'warn', msg }),
      error: (msg: string) => logs.push({ level: 'error', msg }),
    };
    host.log = rec as never;
    await m.start(host);
    const warn = logs.find((l) => l.level === 'warn' && l.msg.includes('自带后端拉不起来'));
    expect(warn?.msg).toMatch(/缺文件|权重文件不存在/);
    const st = await invoke('listen', 'state') as AsrListenState;
    expect(st.detail).toMatch(/^后端拉不起来: /);
    await m.stop();
  });

  it('出口纠错表:整段替换,长词先换,不碰幻觉过滤', async () => {
    const { m, speak, tick, invoke } = rig(
      { corrections: '可提=可缇；克提=可缇\n可提提=可缇听' },
      ['可提提到吗', '我是黑子了克提加油吧'],
    );
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(host.events.map((e) => e.text)).toEqual([
      expect.stringContaining('可缇听到吗'),
      expect.stringContaining('我是黑子了可缇加油吧'),
    ]);
    await m.stop();
  });
});

describe('收听面板', () => {
  it('启停收听、换设备都回一份新状态', async () => {
    const { m, config, capture, invoke } = rig();
    const host = new FakeHost();
    await m.start(host);
    const off = await invoke('listen', 'state') as AsrListenState;
    expect(off.listening).toBe(false);

    const on = await invoke('listen', 'start') as AsrListenState;
    expect(on.listening).toBe(true);
    expect(capture.running).toBe(true);

    const moved = await invoke('listen', 'setDevice', ['USB Mic']) as AsrListenState;
    expect(config.device).toBe('USB Mic');
    expect(moved.listening).toBe(true); // 换设备是重开一次流,不是停下来

    const stopped = await invoke('listen', 'stop') as AsrListenState;
    expect(stopped.listening).toBe(false);
    expect(capture.running).toBe(false);
    await m.stop();
  });

  it('换设备经回调落盘', async () => {
    const seen: string[] = [];
    const m = new AsrWorld({
      cfg: cfg({ streamPort: 0, autoListen: false }),
      onDevice: (d) => seen.push(d),
      captureOverride: { running: false, current: null, devices: () => [], start: () => null, stop: () => {} } as never,
    });
    await m.start(new FakeHost());
    await (m as any).invokePanel('listen', 'setDevice', ['CABLE Output']);
    expect(seen).toEqual(['CABLE Output']);
    await m.stop();
  });

  it('不认识的方法与面板都报错,不静默', async () => {
    const { m, invoke } = rig();
    await m.start(new FakeHost());
    await expect(invoke('listen', 'nope')).rejects.toThrow('未知面板方法');
    await expect(invoke('nope', 'state')).rejects.toThrow('未知面板');
    await m.stop();
  });
});

describe('overlay 面板', () => {
  it('样式钳制:越界回到边界,颜色只收 hex,字体名剥掉能逃出声明的字符', () => {
    const c = clampOverlay({
      maxLines: 99,
      holdMs: 10,
      subtitle: { scale: 9, weight: 5, color: 'red', strokeColor: '#fff', strokeW: -3, plate: 2, fontFamily: 'Foo; } body{' },
    } as never, ASR_OVERLAY_DEFAULTS);
    expect(c.maxLines).toBe(8);
    expect(c.holdMs).toBe(500);
    expect(c.subtitle.scale).toBe(2.5);
    expect(c.subtitle.weight).toBe(100);
    expect(c.subtitle.color).toBe(ASR_OVERLAY_DEFAULTS.subtitle.color); // 'red' 不是 hex
    expect(c.subtitle.strokeColor).toBe('#fff');
    expect(c.subtitle.strokeW).toBe(0);
    expect(c.subtitle.plate).toBe(0.85);
    expect(c.subtitle.fontFamily).toBe('Foo  body');
  });

  it('改样式即时落盘并热推;试显不经识别直接进字幕流', async () => {
    const saved: unknown[] = [];
    const { m, invoke } = rig();
    (m as any).onOverlayConfig = (c: unknown) => saved.push(c);
    await m.start(new FakeHost());
    const st = await invoke('overlay', 'setConfig', [{ maxLines: 4 }]) as AsrOverlayState;
    expect(st.config.maxLines).toBe(4);
    expect(saved).toHaveLength(1);
    expect(st.url).toContain('/overlay');
    const after = await invoke('overlay', 'test', ['喂喂喂']) as AsrOverlayState;
    expect(after.streamUp).toBe(true);
    await m.stop();
  });
});

describe('端点端口', () => {
  it('自带后端就起在端点地址那个口上', () => {
    expect(portOf('http://127.0.0.1:8793/v1', 1)).toBe(8793);
    expect(portOf('https://api.groq.com/openai/v1', 1)).toBe(443);
    expect(portOf('不是地址', 8793)).toBe(8793);
  });

});

describe('中文字形与权重选择', () => {
  it('识别回来是繁体,投出去是简体', async () => {
    const { m, speak, tick, invoke } = rig(
      { pack: { joinGapMs: 0, maxHoldMs: 8000, minChars: 2 } },
      ['今天天氣不錯,我們出去走走吧'],
    );
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(host.events[0].text).toContain('今天天气不错,我们出去走走吧');
    await m.stop();
  });

  it('关掉转换就原样带出去', async () => {
    const { m, speak, tick, invoke } = rig(
      {
        pack: { joinGapMs: 0, maxHoldMs: 8000, minChars: 2 },
        backend: { ...ASR_DEFAULTS.backend, simplified: false } as never,
      },
      ['今天天氣不錯'],
    );
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(host.events[0].text).toContain('今天天氣不錯');
    await m.stop();
  });

  it('繁体的幻觉台词也挡得住:先定字形再过滤,名单只按简体写一份', async () => {
    const { m, speak, tick, invoke } = rig({}, ['謝謝觀看']);
    const host = new FakeHost();
    await m.start(host);
    await invoke('listen', 'start');
    speak(1000, loud());
    speak(800, FRAME);
    await settle(tick);
    expect(host.events).toHaveLength(0);
    await m.stop();
  });

  it('换权重:落到配置里并经回调落盘,后端没跑就只说下次用哪份', async () => {
    const seen: string[] = [];
    const { m, config, invoke } = rig();
    (m as any).onModelFile = (f: string) => seen.push(f);
    await m.start(new FakeHost());
    const st = await invoke('listen', 'setModel', ['ggml-large-v3.bin']) as AsrListenState;
    expect(config.backend.modelFile).toBe('ggml-large-v3.bin');
    expect(seen).toEqual(['ggml-large-v3.bin']);
    expect(st.modelFile).toBe('ggml-large-v3.bin');
    expect(st.detail).toContain('下次启动后端');
    await m.stop();
  });
});
