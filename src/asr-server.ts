/** Managed FireRedASR2-AED process. Runtime and weights are deployment assets outside Git. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';
import { pythonExe, runtimeUsable, sourceDir } from './runtime/env.ts';
import { MODEL_FILES, MODEL_NAME } from './runtime/models.ts';

type AsrServerPhase = 'stopped' | 'starting' | 'running' | 'error';
export type AsrProfile = 'gpu' | 'cpu';
export interface AsrServerState {
  phase: AsrServerPhase; url: string; detail: string | null; pid: number | null;
  reachable: boolean; model: string | null; profile: AsrProfile;
  /** A usable runtime directory exists (managed or self-provided). */
  installed: boolean;
  /** Complete weight sets under `modelsDir`, as `<name>/model.pth.tar`. */
  models: string[];
  modelsDir: string;
}
interface AsrServerOptions {
  /** Directory holding `.venv/` and `FireRedASR2S/`; empty when no runtime is available. */
  runtimeDir: () => string;
  /** `<models root>/asr`; every complete `<name>/` set in it is offered. */
  modelsDir: string;
  port: () => number;
  host?: string;
  profile: () => AsrProfile;
  /** Absolute model.pth.tar path, or a path relative to `modelsDir`; empty picks the managed set. */
  modelFile: () => string;
  threads: () => number;
  log: Logger;
  commandOverride?: { command: string; args: string[] };
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}
const REQUIRED_FILES = MODEL_FILES.map((spec) => spec.file);
const SERVER_SCRIPT = fileURLToPath(new URL('./firered-server.py', import.meta.url));

export function listModels(modelsDir: string): string[] {
  if (!existsSync(modelsDir)) return [];
  return readdirSync(modelsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && REQUIRED_FILES.every((file) => existsSync(join(modelsDir, entry.name, file))))
    .map((entry) => join(entry.name, 'model.pth.tar')).sort();
}
export function pickModel(modelsDir: string): string | null {
  const models = listModels(modelsDir);
  return models.find((file) => basename(dirname(file)) === MODEL_NAME) ?? models[0] ?? null;
}
export const binPath = pythonExe;

/** Windows venv launchers spawn another Python process; stopping only the launcher leaves the GPU occupied. */
async function terminate(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || !proc.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', () => resolve());
      killer.once('error', () => { proc.kill(); resolve(); });
    });
  } else {
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
      proc.once('exit', () => { clearTimeout(force); resolve(); });
      proc.kill();
    });
  }
}

export class AsrServerManager {
  private phase: AsrServerPhase = 'stopped';
  private detail: string | null = null;
  private proc: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stderrTail = '';
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: AsrServerOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  get url(): string { return `http://${this.host}:${this.opts.port()}`; }
  get currentPhase(): AsrServerPhase { return this.phase; }
  get logTail(): string { return this.stderrTail; }
  async state(): Promise<AsrServerState> {
    const profile = this.opts.profile();
    const modelPath = this.chosenModelPath();
    const modelReady = modelPath && REQUIRED_FILES.every(file => existsSync(join(dirname(modelPath), file)));
    const runtime = this.opts.runtimeDir();
    return {
      phase: this.phase, url: this.url, detail: this.detail, pid: this.proc?.pid ?? null,
      reachable: await this.probe(), model: modelReady ? basename(dirname(modelPath!)) : null, profile,
      installed: runtime !== '' && runtimeUsable(runtime),
      models: listModels(this.opts.modelsDir),
      modelsDir: this.opts.modelsDir,
    };
  }
  async start(): Promise<AsrServerState> {
    if (this.phase === 'starting' || this.phase === 'running') return this.state();
    if (await this.probe()) {
      this.detail = '端点已有服务在跑(外部启动),无需托管';
      return this.state();
    }
    const launch = this.resolveLaunch();
    if ('error' in launch) {
      this.phase = 'error'; this.detail = launch.error;
      return this.state();
    }
    this.stderrTail = '';
    let proc: ChildProcess;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: launch.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1' },
      });
    } catch (err) {
      this.phase = 'error'; this.detail = spawnFailDetail(err as NodeJS.ErrnoException, launch.command);
      return this.state();
    }
    this.proc = proc; this.phase = 'starting'; this.detail = '加载 FireRedASR2-AED 并预热';
    const tail = (chunk: Buffer): void => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000); };
    proc.stderr?.on('data', tail); proc.stdout?.on('data', tail);
    // 后端自己的日志逐行进运行日志(区域 server);面板与退出文案只用尾巴
    const serverLog = this.opts.log.child('server');
    for (const [stream, event] of [[proc.stderr, 'stderr'], [proc.stdout, 'stdout']] as const) {
      createInterface({ input: stream! }).on('line', (raw) => {
        const line = raw.trim();
        if (line) serverLog.emit('debug', line, { event });
      });
    }
    proc.on('error', (err) => { if (this.proc === proc) this.fail(`进程启动失败: ${err.message}`); });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.fail(`进程退出 code=${code};日志尾部: ${this.stderrTail.slice(-400)}`, { event: 'exit', data: { exitCode: code } });
    });
    this.opts.log.info(`FireRedASR2-AED 启动中 pid=${proc.pid} ${this.url}(${this.opts.profile()})`);
    this.beginHealthPolling(proc);
    return this.state();
  }
  async stop(): Promise<AsrServerState> {
    this.clearHealthTimer(); this.phase = 'stopped'; this.detail = null;
    const proc = this.proc; this.proc = null;
    if (proc) { await terminate(proc); this.opts.log.info('识别后端已停止'); }
    return this.state();
  }
  async probe(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(2000) });
      // External transcription endpoints can return 404 at their root.
      return response.status < 500;
    } catch { return false; }
  }
  private chosenModelPath(): string | null {
    const want = this.opts.modelFile().trim();
    if (want) return isAbsolute(want) ? want : join(this.opts.modelsDir, want);
    const picked = pickModel(this.opts.modelsDir);
    return picked ? join(this.opts.modelsDir, picked) : null;
  }
  private resolveLaunch(): { command: string; args: string[]; cwd?: string } | { error: string } {
    if (this.opts.commandOverride) return this.opts.commandOverride;
    const runtime = this.opts.runtimeDir();
    if (!runtime || !runtimeUsable(runtime)) {
      return { error: `缺文件: ${runtime ? `${runtime} 里没有 .venv 与 FireRedASR2S` : '识别运行时未安装'};在「收听」面板安装,或在配置里给出自备目录` };
    }
    const model = this.chosenModelPath();
    if (!model) return { error: '缺权重: 在「收听」面板下载 FireRedASR2-AED,或选择自备的 model.pth.tar' };
    if (!existsSync(model)) return { error: `权重文件不存在: ${model}` };
    if (basename(model) !== 'model.pth.tar') return { error: '请选择 FireRedASR2-AED 的 model.pth.tar' };
    for (const file of REQUIRED_FILES) {
      if (!existsSync(join(dirname(model), file))) return { error: `缺权重配套文件: ${join(dirname(model), file)}` };
    }
    return { command: pythonExe(runtime), cwd: runtime,
      args: [SERVER_SCRIPT, '--host', this.host, '--port', String(this.opts.port()), '--source-dir', sourceDir(runtime),
        '--model-file', model, '--device', this.opts.profile() === 'gpu' ? 'cuda' : 'cpu', '--threads', String(this.opts.threads() || 4)],
    };
  }
  private beginHealthPolling(proc: ChildProcess): void {
    this.clearHealthTimer();
    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 180_000);
    this.healthTimer = setInterval(async () => {
      const ready = await this.probe();
      if (this.proc !== proc || this.phase !== 'starting') return;
      if (ready) {
        this.phase = 'running'; this.detail = null; this.clearHealthTimer();
        this.opts.log.info(`FireRedASR2-AED 已预热就绪 ${this.url}`);
      } else if (Date.now() > deadline) {
        this.fail(`health 检查超时;日志尾部: ${this.stderrTail.slice(-400)}`);
        this.proc = null; await terminate(proc);
      }
    }, this.opts.healthIntervalMs ?? 2000);
  }
  private clearHealthTimer(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }
  private fail(detail: string, record: { event?: string; data?: Record<string, unknown> } = {}): void {
    this.clearHealthTimer(); this.phase = 'error'; this.detail = detail;
    this.opts.log.emit('warn', `识别后端异常: ${detail}`, { event: record.event, data: { detail, ...record.data } });
  }
}
export function spawnFailDetail(err: NodeJS.ErrnoException, command: string): string {
  if (err.code === 'UNKNOWN' && process.platform === 'win32') {
    return `启动被系统拦下(${command})。请检查 Windows 智能应用控制对该运行环境的限制。`;
  }
  return `进程启动失败: ${err.message}`;
}
