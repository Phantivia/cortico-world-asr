import type { WorldDefinition } from 'cortico/world.ts';
import { ASR_DEFAULTS, AsrWorld, type AsrConfigSection } from './world.ts';

export const ASR: WorldDefinition<AsrConfigSection> = {
  id: 'asr',
  label: '语音识别',
  defaults: () => structuredClone(ASR_DEFAULTS as unknown as AsrConfigSection),
  create: (ctx) =>
    new AsrWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      onDevice: (device) => ctx.persist({ device }),
      onOverlayConfig: (overlay) => ctx.persist({ overlay }),
      onModelFile: (modelFile) => ctx.persist({ backend: { modelFile } }),
    }),
};
