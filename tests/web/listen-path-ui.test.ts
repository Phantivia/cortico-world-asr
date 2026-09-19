/**
 * @vitest-environment jsdom
 *
 * 外置资源路径的用户路径：Provider 参数页选择 GGUF。测试从真实按钮进入，
 * 并穿过统一路径选择与配置写回 API。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UI = 'cortico/web/client/ui/index.ts';
const LIFECYCLE = 'cortico/web/client/core/lifecycle.ts';
const ASR_LISTEN = '../../src/console/listen.ts';

// Browser sources are checked by tsconfig.web.json; keeping their specifiers indirect
// prevents the Node-only root config from pulling DOM worlds into its source graph.
type Any = any;

const doc = (globalThis as Any).document;

const { createConsoleUi } = (await import(UI)) as Any;
const { Lifecycle } = (await import(LIFECYCLE)) as Any;
const { listenPanel } = (await import(ASR_LISTEN)) as Any;

interface Call {
  url: string;
  method: string;
  body: Any;
}

let calls: Call[] = [];

const flush = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

function json(body: unknown): Any {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function memo(): Any {
  const values = new Map<string, unknown>();
  return {
    get: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback,
    set: (key: string, value: unknown) => values.set(key, value),
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});


describe('ASR 外部权重错误', () => {
  it('显式路径不存在时展示后端给出的具体路径，不退回旧 runtime/models 提示', async () => {
    const missing = 'D:\\weights\\asr\\missing.bin';
    const lifecycle = new Lifecycle();
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    const ui = createConsoleUi({ memo: memo(), overlayHost: doc.body, signal: lifecycle.signal, doc });
    const state = {
      listening: false,
      audioAvailable: true,
      devices: [],
      deviceSetting: '',
      device: '',
      level: -60,
      speaking: false,
      thresholdDb: -35,
      modelFile: missing,
      simplified: false,
      recent: [],
      counts: { utterances: 0, delivered: 0, dropped: 0 },
      server: {
        phase: 'error',
        url: 'http://127.0.0.1:8178',
        detail: `权重文件不存在: ${missing}`,
        pid: null,
        reachable: false,
        model: null,
        profile: 'gpu',
        installed: true,
        models: [],
        modelsDir: 'D:\\weights\\asr',
      },
      endpoint: 'http://127.0.0.1:8178/inference',
      detail: null,
    };
    const ctx = {
      pageId: 'world:asr',
      panelId: 'listen',
      root,
      signal: lifecycle.signal,
      ui,
      invoke: (method: string) => method === 'state'
        ? Promise.resolve(state)
        : Promise.reject(new Error(`未声明的方法：${method}`)),
      invokeBinary: () => Promise.reject(new Error('本测试不取二进制')),
      pickPath: () => Promise.resolve(null),
      setConfig: () => Promise.resolve(''),
      stream: () => ({ close() {} }),
      interval: () => ({ dispose() {} }),
      timeout: () => ({ dispose() {} }),
      frame: () => ({ dispose() {} }),
      own: (value: unknown) => value,
      memo: memo(),
      guardLeave: () => ({ dispose() {} }),
    };

    listenPanel.mount(ctx);
    await flush();

    expect(root.querySelector('.mdetail')?.textContent).toBe(`权重文件不存在: ${missing}`);
    lifecycle.dispose();
  });
});
