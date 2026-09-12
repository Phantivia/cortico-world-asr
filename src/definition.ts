import type { WorldDefinition } from 'cortico/world.ts';
import { ASR_MODULE_DEFAULTS, AsrModule, type AsrConfigSection } from './module.ts';

export const ASR: WorldDefinition<AsrConfigSection> = {
  id: 'asr',
  label: '语音识别',
  defaults: () => structuredClone(ASR_MODULE_DEFAULTS as unknown as AsrConfigSection),
  create: (ctx) =>
    new AsrModule({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      onDevice: (device) => ctx.persist({ device }),
      onOverlayConfig: (overlay) => ctx.persist({ overlay }),
      onModelFile: (modelFile) => ctx.persist({ backend: { modelFile } }),
    }),
};
