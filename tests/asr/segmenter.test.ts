/**
 * 切分与打包:这两处全是参数,而参数对不对只有拿信号的形状去验才说得清。
 * 夹具直接合成正弦(说话)与静音(不说话),按帧喂进去。
 */
import { describe, expect, it } from 'vitest';
import {
  Packer, PACK_DEFAULTS, rmsDb, Segmenter, SEGMENT_DEFAULTS,
  type SegmentConfig, type Utterance,
} from '../../src/segmenter.ts';

const FRAME_MS = 20;
const RATE = 16_000;
const FRAME_LEN = (RATE * FRAME_MS) / 1000;

/** 一帧正弦;amp 是峰值幅度(0–1) */
function tone(amp: number): Int16Array {
  const f = new Int16Array(FRAME_LEN);
  for (let i = 0; i < FRAME_LEN; i++) f[i] = Math.round(Math.sin((i / RATE) * 2 * Math.PI * 220) * amp * 32767);
  return f;
}
const SILENCE = new Int16Array(FRAME_LEN);
/** 人声档:峰值 0.3 → 约 -13 dBFS */
const LOUD = tone(0.3);

function feed(seg: Segmenter, frame: Int16Array, ms: number): Utterance[] {
  const out: Utterance[] = [];
  for (let t = 0; t < ms; t += FRAME_MS) out.push(...seg.push(frame));
  return out;
}

function make(over: Partial<SegmentConfig> = {}): Segmenter {
  return new Segmenter({ ...SEGMENT_DEFAULTS, ...over }, FRAME_MS);
}

describe('电平', () => {
  it('静音是地板,正弦按幅度给出 dBFS', () => {
    expect(rmsDb(SILENCE)).toBe(-100);
    // 正弦的 RMS 是峰值的 1/√2:0.3 → 约 -13.4 dB
    expect(rmsDb(LOUD)).toBeGreaterThan(-15);
    expect(rmsDb(LOUD)).toBeLessThan(-12);
    expect(rmsDb(tone(0.01))).toBeLessThan(-35);
  });
});

describe('切分', () => {
  it('说一句 → 停下来:短门限交货,长门限才算说完,切出来的长度含前置回溯', () => {
    const seg = make();
    expect(feed(seg, SILENCE, 400)).toHaveLength(0);
    expect(feed(seg, LOUD, 1000)).toHaveLength(0); // 还在说
    expect(seg.active).toBe(true);
    // 送转写的门限还没到:不交货
    expect(feed(seg, SILENCE, 200)).toHaveLength(0);
    const done = feed(seg, SILENCE, 100);
    expect(done).toHaveLength(1);
    expect(seg.active).toBe(false);
    // 1000ms 说话 + 250ms 那一级静音 + 越线之前那一段;尾巴带的是短门限那一截
    expect(done[0].durationMs).toBeGreaterThan(1300);
    expect(done[0].durationMs).toBeLessThan(1500);
    expect(done[0].pcm.length).toBe((done[0].durationMs / 1000) * RATE);
    expect(done[0].forced).toBe(false);
    // 音频交出去了,但这一段还没"说完":发车的判据还按着
    expect(seg.settleRemainingMs).toBeGreaterThan(0);
    feed(seg, SILENCE, 260);
    expect(seg.settleRemainingMs).toBe(0);
  });

  it('短门限之后接着说:后半段照常收,不留空档', () => {
    const seg = make();
    feed(seg, LOUD, 600);
    const first = feed(seg, SILENCE, 300); // 过短门限,没过长门限
    expect(first).toHaveLength(1);
    expect(seg.settleRemainingMs).toBeGreaterThan(0);
    // 人在窗口里接着说:重新进入说话中,长门限这条持有交给 active
    feed(seg, LOUD, 400);
    expect(seg.active).toBe(true);
    expect(seg.settleRemainingMs).toBe(0);
    const second = feed(seg, SILENCE, 300);
    expect(second).toHaveLength(1);
    expect(second[0].startMs).toBeGreaterThan(first[0].startMs);
  });

  it('起说判定那 180ms 也算"还没说完":不能在这个缝里把前半句送走', () => {
    const seg = make();
    feed(seg, LOUD, 600);
    feed(seg, SILENCE, 600); // 长门限已过
    expect(seg.settleRemainingMs).toBe(0);
    feed(seg, LOUD, 60); // 能量越线了,还不够 minSpeechMs
    expect(seg.active).toBe(false);
    expect(seg.settleRemainingMs).toBeGreaterThan(0);
  });

  it('短门限给到长门限之上:退回单级,以长的为准', () => {
    const seg = make({ dispatchSilenceMs: 5000 });
    feed(seg, LOUD, 600);
    expect(feed(seg, SILENCE, 300)).toHaveLength(0); // 短门限不再提前交货
    expect(feed(seg, SILENCE, 260)).toHaveLength(1); // 到长门限才交
  });

  it('门槛之前那几帧带上:开口的第一个字总在能量越线之前', () => {
    const say = (preRollMs: number): number => {
      const seg = make({ preRollMs });
      feed(seg, SILENCE, 1000);
      // 说够 400ms:回溯给 0 时切出来的片段也要过得了 minUtteranceMs
      feed(seg, LOUD, 400);
      return feed(seg, SILENCE, 800)[0].durationMs;
    };
    // 回溯只多带"越线之前"那一段:200ms 的窗口里有 180ms 是起说判定本身占掉的
    expect(say(200) - say(0)).toBeGreaterThanOrEqual(180);
  });

  it('一声脆响不算开口:短于起说时长的能量挡在外面', () => {
    const seg = make({ minSpeechMs: 200 });
    feed(seg, SILENCE, 400);
    expect(feed(seg, LOUD, 100)).toHaveLength(0);
    expect(seg.active).toBe(false);
    expect(feed(seg, SILENCE, 1000)).toHaveLength(0);
  });

  it('一直说不停:到上限强切,切完接着收下一段', () => {
    const seg = make({ maxUtteranceMs: 1000 });
    const first = feed(seg, LOUD, 1100);
    expect(first).toHaveLength(1);
    expect(first[0].forced).toBe(true);
    expect(seg.active).toBe(true); // 人还在说
    const second = feed(seg, LOUD, 1000);
    expect(second).toHaveLength(1);
    expect(second[0].startMs).toBeGreaterThan(first[0].startMs);
  });

  it('太短的片段丢掉,不送去识别', () => {
    const seg = make({ minSpeechMs: 20, minUtteranceMs: 5000 });
    feed(seg, LOUD, 300);
    expect(feed(seg, SILENCE, 1000)).toHaveLength(0);
  });

  it('停止采集时手上那半句交出来', () => {
    const seg = make();
    feed(seg, LOUD, 1000);
    const tail = seg.flush();
    expect(tail).not.toBeNull();
    expect(tail!.durationMs).toBeGreaterThanOrEqual(1000);
    expect(seg.flush()).toBeNull(); // 交过就没了
  });

  it('停止采集之后没有"还没说完"这回事:不留着等一个不再来的帧', () => {
    const seg = make();
    feed(seg, LOUD, 600);
    feed(seg, SILENCE, 300); // 交了货,还在收尾静音窗里
    expect(seg.settleRemainingMs).toBeGreaterThan(0);
    seg.flush();
    expect(seg.settleRemainingMs).toBe(0);
  });

  it('门槛热改即生效:调高之后同样的信号不再算说话', () => {
    const seg = make();
    seg.configure({ ...SEGMENT_DEFAULTS, thresholdDb: -5 });
    feed(seg, LOUD, 1000);
    expect(seg.active).toBe(false);
  });
});

describe('打包投递', () => {
  const cfg = { ...PACK_DEFAULTS, joinGapMs: 1000, maxHoldMs: 5000, minChars: 2 };

  it('停顿短的并成一条,静下来才发车', () => {
    const p = new Packer(cfg);
    p.add('今天天气不错', 1000);
    expect(p.due(1500)).toBeNull(); // 还在说
    p.add('要不要出去走走', 1800);
    expect(p.due(2500)).toBeNull();
    expect(p.due(2900)).toBe('今天天气不错 要不要出去走走');
    expect(p.due(9999)).toBeNull(); // 交过就空了
  });

  it('一直连着说也要发车:攒够上限就交货', () => {
    const p = new Packer(cfg);
    p.add('第一句', 0);
    for (let t = 500; t <= 5000; t += 500) p.add('还在说', t);
    // 每 500ms 就有新的一句,静默那条永远不满足;是攒批上限把它推出去的
    expect(p.due(5000)).toContain('第一句');
  });

  it('默认不额外等:上游一空就发车,并句交给切分层的收尾静音', () => {
    const p = new Packer(PACK_DEFAULTS);
    p.add('听得见吗', 1000);
    expect(p.due(1000, true)).toBeNull(); // 上游还没空
    expect(p.due(1000, false)).toBe('听得见吗'); // 同一刻,一撤就走
  });

  it('麦克风或转写仍有活动时，到点也继续持有', () => {
    const p = new Packer(cfg);
    p.add('前半句', 1000);
    expect(p.due(6000, true)).toBeNull();
    expect(p.pending).toBe(true);
    expect(p.due(6000, false)).toBe('前半句');
  });

  it('太短的识别结果丢掉:噪声出来常是一两个字', () => {
    const p = new Packer(cfg);
    expect(p.add('嗯', 0)).toBe(false);
    expect(p.pending).toBe(false);
    expect(p.add('  ', 0)).toBe(false);
    expect(p.add('听得见吗', 0)).toBe(true);
  });

  it('take 不看时间,停止收听时把攒着的直接交出来', () => {
    const p = new Packer(cfg);
    p.add('还没说完', 0);
    expect(p.take()).toBe('还没说完');
    expect(p.take()).toBeNull();
  });
});
