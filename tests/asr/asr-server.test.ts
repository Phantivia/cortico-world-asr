import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'cortico/core/types.ts';
import { AsrServerManager, binPath, listModels, pickModel } from '../../src/asr-server.ts';
import { nullLogger } from 'cortico/core/util.ts';

/** A usable runtime directory plus a models root holding the named complete weight sets. */
function layout(names = ['FireRedASR2-AED']) {
  const root = mkdtempSync(join(tmpdir(), 'asr-firered-'));
  const runtime = join(root, 'runtime');
  const models = join(root, 'models', 'asr');
  for (const name of names) {
    mkdirSync(join(models, name), { recursive: true });
    for (const file of ['model.pth.tar', 'cmvn.ark', 'dict.txt', 'train_bpe1000.model'])
      writeFileSync(join(models, name, file), 'fixture');
  }
  mkdirSync(dirname(binPath(runtime)), { recursive: true });
  writeFileSync(binPath(runtime), 'fixture');
  mkdirSync(join(runtime, 'FireRedASR2S', 'fireredasr2s'), { recursive: true });
  writeFileSync(join(runtime, 'FireRedASR2S', 'fireredasr2s', '__init__.py'), '');
  return { runtime, models };
}
function manager(l: { runtime: string; models: string }, modelFile = '', profile: 'gpu' | 'cpu' = 'gpu', overrides: object = {}) {
  return new AsrServerManager({ runtimeDir: () => l.runtime, modelsDir: l.models, modelFile: () => modelFile, profile: () => profile,
    port: () => 1, threads: () => 0, log: nullLogger(), ...overrides });
}
function launch(m: AsrServerManager) {
  return (m as unknown as { resolveLaunch(): { command: string; args: string[]; error?: string } }).resolveLaunch();
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

describe('FireRed runtime and model paths', () => {
  it('discovers complete model directories and uses one runtime for both devices', () => {
    const l = layout(['custom', 'FireRedASR2-AED']);
    expect(listModels(l.models)).toHaveLength(2);
    expect(pickModel(l.models)).toBe(join('FireRedASR2-AED', 'model.pth.tar'));
    const gpu = launch(manager(l));
    const cpu = launch(manager(l, '', 'cpu'));
    expect(gpu.command).toBe(cpu.command);
    expect(gpu.args[gpu.args.indexOf('--device') + 1]).toBe('cuda');
    expect(cpu.args[cpu.args.indexOf('--device') + 1]).toBe('cpu');
    expect(gpu.args[gpu.args.indexOf('--threads') + 1]).toBe('4');
  });
  it('loads an absolute external model and reports missing companion files', () => {
    const l = layout();
    const external = mkdtempSync(join(tmpdir(), 'asr-model-'));
    const model = join(external, 'model.pth.tar');
    writeFileSync(model, 'fixture');
    expect(launch(manager(l, model)).error).toContain('cmvn.ark');
    for (const file of ['cmvn.ark', 'dict.txt', 'train_bpe1000.model']) writeFileSync(join(external, file), 'fixture');
    const ready = launch(manager(l, model));
    expect(ready.args[ready.args.indexOf('--model-file') + 1]).toBe(model);
    expect(launch(manager(l, join(external, 'missing.pth.tar'))).error).toContain('权重文件不存在');
  });
  it('rejects a weights file that is not model.pth.tar instead of silently choosing another model', () => {
    const l = layout();
    const old = join(l.models, 'ggml-large-v3.bin');
    writeFileSync(old, 'fixture');
    expect(launch(manager(l, old)).error).toContain('model.pth.tar');
  });
  it('reports a missing or incomplete runtime directory before touching the weights', () => {
    const l = layout();
    expect(launch(manager({ runtime: '', models: l.models })).error).toContain('未安装');
    const bare = mkdtempSync(join(tmpdir(), 'asr-bare-'));
    expect(launch(manager({ runtime: bare, models: l.models })).error).toContain('.venv');
  });
});

describe('managed process lifecycle', () => {
  it.each([200, 404])('reuses an external endpoint with root status %i without stopping it', async (status) => {
    const server = createServer((_req, res) => { res.statusCode = status; res.end('{}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const m = manager(layout(), '', 'gpu', { port: () => port });
    try {
      expect((await m.start()).pid).toBeNull();
      expect((await m.stop()).reachable).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('waits for readiness and terminates the managed process, including Windows launcher children', async () => {
    const port = await freePort();
    const serve = `require('node:http').createServer((q,s)=>s.end('{}')).listen(${port},'127.0.0.1')`;
    const script = process.platform === 'win32'
      ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(serve)}],{windowsHide:true});setInterval(()=>{},1000)`
      : serve;
    const m = manager(layout(), '', 'gpu', { port: () => port, healthIntervalMs: 25,
      commandOverride: { command: process.execPath, args: ['-e', script] } });
    try {
      await m.start();
      await expect.poll(() => m.currentPhase, { timeout: 5000 }).toBe('running');
      expect((await m.state()).pid).not.toBeNull();
    } finally { await m.stop(); }
    await expect.poll(() => m.probe(), { timeout: 5000 }).toBe(false);
  });
  it('kills a process that never becomes ready and reports startup failure', async () => {
    const m = manager(layout(), '', 'gpu', { port: () => 1, healthIntervalMs: 20, healthTimeoutMs: 50,
      commandOverride: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
    try {
      await m.start();
      await expect.poll(() => m.currentPhase, { timeout: 5000 }).toBe('error');
      expect((await m.state()).detail).toContain('检查超时');
    } finally { await m.stop(); }
  });
  it('forwards each stderr/stdout line to the server log area and records the exit code', async () => {
    const logs: Array<{ level: string; area: string; msg: string; event?: string; data?: unknown }> = [];
    const record = (area: string): Logger => ({
      trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
      emit: (level, msg, opts) => logs.push({ level, area, msg, event: opts?.event, data: opts?.data }),
      child: (sub) => record(`${area}.${sub}`),
    });
    const script = 'process.stderr.write("warming "); process.stderr.write("up\\n"); console.log("ready"); process.exit(7)';
    const m = manager(layout(), '', 'gpu', { port: () => 1, healthIntervalMs: 20, healthTimeoutMs: 5000, log: record('worlds.asr'),
      commandOverride: { command: process.execPath, args: ['-e', script] } });
    try {
      await m.start();
      await expect.poll(() => m.currentPhase, { timeout: 5000 }).toBe('error');
      await expect.poll(() => logs.filter(l => l.area === 'worlds.asr.server').length, { timeout: 5000 }).toBe(2);
      expect(logs.filter(l => l.area === 'worlds.asr.server')).toEqual(expect.arrayContaining([
        { level: 'debug', area: 'worlds.asr.server', event: 'stderr', msg: 'warming up', data: undefined },
        { level: 'debug', area: 'worlds.asr.server', event: 'stdout', msg: 'ready', data: undefined },
      ]));
      const exit = logs.find(l => l.event === 'exit')!;
      expect(exit).toMatchObject({ level: 'warn', area: 'worlds.asr', data: { exitCode: 7 } });
      expect(exit.msg).toContain('code=7');
    } finally { await m.stop(); }
  });
});
