/**
 * 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。
 *
 * 配置段类型一并导出,给 bot 侧在 `declares` 覆盖里写 `worlds.asr` 的字面量时用。
 */

import { ASR } from './definition.ts';

export default ASR;

export { ASR };
export type { AsrConfigSection, AsrOverlayConfig, AsrSubtitleStyle } from './world.ts';
