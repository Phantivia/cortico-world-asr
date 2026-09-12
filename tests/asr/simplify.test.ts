/**
 * 繁体 → 简体:识别结果的字形在出口这一层归一。
 *
 * 这里最要紧的一组断言是**已经是简体的句子不被动**:整句丢给 OpenCC 的 t2s
 * 会把"什么"读成繁体、转成"什幺"(不存在的词),那正是这一层最容易出的错。
 */
import { describe, expect, it } from 'vitest';
import { toSimplified } from '../../src/simplify.ts';

describe('中文转简体', () => {
  it('繁体转过来', () => {
    expect(toSimplified('今天天氣不錯,我們出去走走吧')).toBe('今天天气不错,我们出去走走吧');
    expect(toSimplified('幫我把左邊那個箱子打開看看裡面有什麼。')).toBe('帮我把左边那个箱子打开看看里面有什么。');
    expect(toSimplified('頭髮很長')).toBe('头发很长');
    expect(toSimplified('後天再說')).toBe('后天再说');
  });

  it('已经是简体的原样不动——"什么"不许变成"什幺"', () => {
    for (const s of [
      '帮我把左边那个箱子打开看看里面有什么',
      '今天天气不错,我们出去走走吧',
      '这一局五子棋你下得太急了',
      '以后再说',
      '幺妹儿今天来了', // 幺 是正经字,不是"么"的繁体
    ]) {
      expect(toSimplified(s), s).toBe(s);
    }
  });

  it('英文、数字、空串原样', () => {
    expect(toSimplified('Hello, world! 123')).toBe('Hello, world! 123');
    expect(toSimplified('')).toBe('');
  });

  it('只管字形不管用词:人说了什么词就是什么词', () => {
    // tw→cn 那条路会把"滑鼠"换成"鼠标";这一层不做这种事
    expect(toSimplified('滑鼠')).toBe('滑鼠');
  });
});
