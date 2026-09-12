/**
 * 繁体 → 简体:识别结果的字形在**出口**这一层归一,由 `worlds.asr.backend.simplified` 控制,默认开。
 * 当前后端 FireRedASR2-AED 的输出字形没有实测过,这一层是无条件兜底。
 *
 * **不能整句丢给 OpenCC 的 t2s。** 那条路把已经是简体的句子也当繁体读:
 * "什么"的"么"在繁体里是"幺"的异体,于是 `什么` 被转成 `什幺`——一个不存在的词。
 * 所以逐字判断:**这个字有没有另一个繁体形**(`s2t(c) !== c`),有就说明它本身
 * 已经是简体,原样留着;没有才交给 t2s。`幺妹`、`以后`、`面条` 都因此不被动。
 *
 * 用 `from: 't'` 而不是 `'tw'`:后者连用词一起换(滑鼠→鼠标)。人说了什么词
 * 就是什么词,这一层只管字形。
 */
import * as OpenCC from 'opencc-js';

type Converter = (text: string) => string;

let t2s: Converter | null = null;
let s2t: Converter | null = null;
/** 逐字结论按字缓存:一句话里重复的字很多,转换器调用不便宜 */
const memo = new Map<string, string>();

function converters(): { t2s: Converter; s2t: Converter } {
  t2s ??= OpenCC.Converter({ from: 't', to: 'cn' });
  s2t ??= OpenCC.Converter({ from: 'cn', to: 't' });
  return { t2s, s2t };
}

function simplifyChar(ch: string): string {
  const hit = memo.get(ch);
  if (hit !== undefined) return hit;
  const { t2s: toS, s2t: toT } = converters();
  // 有另一个繁体形 = 它自己已经是简体,别动它
  const out = toT(ch) !== ch ? ch : toS(ch);
  memo.set(ch, out);
  return out;
}

export function toSimplified(text: string): string {
  if (!text) return text;
  // 全 ASCII 的句子没有可转的字,省掉一次遍历
  if (/^[\x00-\x7f]*$/.test(text)) return text;
  let out = '';
  for (const ch of text) out += simplifyChar(ch);
  return out;
}

// ---------------------------------------------------------------------------
// 出口纠错表:人名、圈内词这类按音猜字的固定错法,在这一层整段替换。
// ---------------------------------------------------------------------------

type Correction = readonly [wrong: string, right: string];

/**
 * 解析配置里的纠错表:每条 `错=对`(也认 `错→对`),条目之间换行或分号隔开。
 * 空条目、没有分隔符的行、左边为空的行都跳过;左边越长越先替换,免得短词先把长词拆掉。
 */
export function parseCorrections(text: string): Correction[] {
  const out: Correction[] = [];
  for (const raw of text.split(/[\n;；]/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.search(/[=→]/);
    if (at <= 0) continue;
    const wrong = line.slice(0, at).trim();
    const right = line.slice(at + 1).trim();
    if (!wrong) continue;
    out.push([wrong, right]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

export function applyCorrections(text: string, table: readonly Correction[]): string {
  let out = text;
  for (const [wrong, right] of table) out = out.split(wrong).join(right);
  return out;
}
