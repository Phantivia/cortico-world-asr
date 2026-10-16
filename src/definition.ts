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
  describe: {
    tools: [],
    events: [
      {
        type: 'asr.speech',
        description: {
          zh: '从麦克风识别出的话,前面标着说话人的称呼。开了「听见就叫醒」(worlds.asr.wake)时立即投递,否则与其他事件合批。',
          en: 'Speech recognized from the microphone, prefixed with the speaker name. Delivered at once when worlds.asr.wake is on; otherwise batched with other events.',
        },
      },
    ],
  },
};
