import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import {
  PINNED_SOURCE_REVISION, RUNTIME_MARKER, RuntimeStore, envPlan, installSteps, pythonExe, runtimeUsable,
  type CommandRun, type CommandRunner,
} from '../../src/runtime/env.ts';
import { MODEL_FILES, MODEL_REVISION, ModelStore, modelFileUrl } from '../../src/runtime/models.ts';

const PLAN = { key: 'cu128' };

/** Records every command; `code` decides the exit code per step name, ENOENT simulates a missing tool. */
function fakeRunner(behaviour: { fail?: string; enoent?: string; hold?: Promise<void> } = {}) {
  const calls: CommandRun[] = [];
  const runner: CommandRunner = async (run) => {
    calls.push(run);
    if (behaviour.hold) await behaviour.hold;
    if (run.command === behaviour.enoent) {
      throw Object.assign(new Error(`spawn ${run.command} ENOENT`), { code: 'ENOENT' });
    }
    run.onLine(`${run.command} ${run.args[0]} running`);
    return run.args.join(' ').includes(behaviour.fail ?? '\0') ? 1 : 0;
  };
  return { calls, runner };
}

describe('managed runtime environment', () => {
  it('has a plan on Windows and Linux and none elsewhere', () => {
    expect(envPlan('win32')).toEqual(PLAN);
    expect(envPlan('linux')).toEqual(PLAN);
    expect(envPlan('darwin')).toBeNull();
  });

  it('installs into a partial directory, writes the marker, then renames into place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'asr-runtime-'));
    const { calls, runner } = fakeRunner();
    const store = new RuntimeStore(root, nullLogger(), runner);
    const dir = store.dir(PINNED_SOURCE_REVISION, PLAN);
    expect(store.state(dir).phase).toBe('absent');

    await store.install(PINNED_SOURCE_REVISION, PLAN);

    expect(calls.map((c) => c.command)).toEqual(installSteps(dir, PINNED_SOURCE_REVISION).map((s) => s.command));
    // every step targeted the partial directory, never the final one
    for (const call of calls) expect(call.args.join(' ')).not.toContain(`${dir} `);
    expect(calls[1]!.args).toContain(PINNED_SOURCE_REVISION);
    expect(store.installed(dir)).toBe(true);
    expect(existsSync(`${dir}.partial`)).toBe(false);
    expect(store.marker(dir)).toMatchObject({ runtime: 'firered-asr', revision: PINNED_SOURCE_REVISION, key: 'cu128' });
    expect(store.state(dir).phase).toBe('installed');
  });

  it('a failing step removes the partial directory and reports the step by name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'asr-runtime-'));
    const { runner } = fakeRunner({ fail: 'venv' });
    const store = new RuntimeStore(root, nullLogger(), runner);
    const dir = store.dir('abcdef0123456789', PLAN);

    await expect(store.install('abcdef0123456789', PLAN)).rejects.toThrow('建 Python 环境失败');
    expect(store.state(dir)).toMatchObject({ phase: 'error' });
    expect(store.state(dir).detail).toContain('退出码 1');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.partial`)).toBe(false);
  });

  it('a missing tool names the tool instead of a spawn error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'asr-runtime-'));
    const { runner } = fakeRunner({ enoent: 'uv' });
    const store = new RuntimeStore(root, nullLogger(), runner);
    await expect(store.install(PINNED_SOURCE_REVISION, PLAN)).rejects.toThrow('找不到 uv');
  });

  it('refuses a second install while one is running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'asr-runtime-'));
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { runner } = fakeRunner({ hold });
    const store = new RuntimeStore(root, nullLogger(), runner);
    const first = store.install(PINNED_SOURCE_REVISION, PLAN);
    expect(store.state(store.dir(PINNED_SOURCE_REVISION, PLAN))).toMatchObject({ phase: 'installing', step: '取上游代码' });
    await expect(store.install(PINNED_SOURCE_REVISION, PLAN)).rejects.toThrow('已经有一个运行时在安装');
    release();
    await first;
  });

  it('a self-provided directory counts as usable only with both the venv and the source tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asr-own-'));
    expect(runtimeUsable(dir)).toBe(false);
    mkdirSync(join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
    writeFileSync(pythonExe(dir), '');
    expect(runtimeUsable(dir)).toBe(false);
    mkdirSync(join(dir, 'FireRedASR2S', 'fireredasr2s'), { recursive: true });
    writeFileSync(join(dir, 'FireRedASR2S', 'fireredasr2s', '__init__.py'), '');
    expect(runtimeUsable(dir)).toBe(true);
  });
});

describe('managed weights', () => {
  const body = (file: string): string => `bytes of ${file}`;
  const fetchOk: typeof fetch = async (input) => {
    const url = String(input);
    const file = MODEL_FILES.find((spec) => url === modelFileUrl(spec.file))!.file;
    return new Response(body(file), { status: 200, headers: { 'content-length': String(body(file).length) } });
  };

  it('downloads every missing file from the pinned revision and reports them present', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'asr-models-')), 'FireRedASR2-AED');
    const store = new ModelStore(dir, nullLogger(), fetchOk);
    expect(store.complete()).toBe(false);
    expect(store.states().every((s) => s.phase === 'absent')).toBe(true);

    await store.downloadMissing();

    expect(store.complete()).toBe(true);
    for (const spec of MODEL_FILES) expect(readFileSync(join(dir, spec.file), 'utf8')).toBe(body(spec.file));
    expect(store.states().map((s) => [s.file, s.phase, s.bytes])).toEqual(
      MODEL_FILES.map((spec) => [spec.file, 'present', body(spec.file).length]),
    );
    expect(readdirSync(dir).some((name) => name.endsWith('.partial'))).toBe(false);
    expect(modelFileUrl('dict.txt')).toContain(MODEL_REVISION);
  });

  it('a failed download leaves no partial file, records the error, and a retry only fetches what is missing', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'asr-models-')), 'FireRedASR2-AED');
    writeFileSync(join(dir, '..', 'placeholder'), '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.pth.tar'), 'already here');
    const fetched: string[] = [];
    let failOnce = true;
    const fetchFlaky: typeof fetch = async (input, init) => {
      fetched.push(String(input));
      if (failOnce && String(input).endsWith('cmvn.ark')) {
        failOnce = false;
        return new Response('nope', { status: 503 });
      }
      return fetchOk(input, init);
    };
    const store = new ModelStore(dir, nullLogger(), fetchFlaky);

    await expect(store.downloadMissing()).rejects.toThrow('cmvn.ark');
    expect(store.states().find((s) => s.file === 'cmvn.ark')).toMatchObject({ phase: 'error', detail: 'HTTP 503' });
    expect(existsSync(join(dir, 'cmvn.ark.partial'))).toBe(false);

    await store.downloadMissing();
    expect(store.complete()).toBe(true);
    expect(readFileSync(join(dir, 'model.pth.tar'), 'utf8')).toBe('already here');
    expect(fetched.filter((url) => url.endsWith('model.pth.tar'))).toHaveLength(0);
  });
});
