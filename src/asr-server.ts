/** Managed FireRedASR2-AED process. Runtime and weights are deployment assets outside Git. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';

type AsrServerPhase = 'stopped' | 'starting' | 'running' | 'error';
export type AsrProfile = 'gpu' | 'cpu';
export interface AsrServerState {
  phase: AsrServerPhase; url: string; detail: string | null; pid: number | null;
  reachable: boolean; model: string | null; profile: AsrProfile; installed: boolean; models: string[];
}
interface AsrServerOptions {
  /** Contains .venv/ and the pinned FireRedASR2S/ source checkout. */
  serverDir: string;
  port: () => number;
  host?: string;
  profile: () => AsrProfile;
  /** Absolute model.pth.tar path, or a path relative to serverDir/models/. */
  modelFile: () => string;
  threads: () => number;
  log: Logger;
  commandOverride?: { command: string; args: string[] };
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}
const MODEL_FILES = ['model.pth.tar', 'cmvn.ark', 'dict.txt', 'train_bpe1000.model'];
const SERVER_SCRIPT = fileURLToPath(new URL('./firered-server.py', import.meta.url));

export function listModels(serverDir: string): string[] {
  const dir = join(serverDir, 'models');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MODEL_FILES.every((file) => existsSync(join(dir, entry.name, file))))
    .map((entry) => join(entry.name, 'model.pth.tar')).sort();
}
export function pickModel(serverDir: string): string | null {
  const models = listModels(serverDir);
  return models.find((file) => basename(dirname(file)) === 'FireRedASR2-AED') ?? models[0] ?? null;
}
export function binPath(serverDir: string): string {
  return process.platform === 'win32' ? join(serverDir, '.venv', 'Scripts', 'python.exe') : join(serverDir, '.venv', 'bin', 'python');
}

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
    const modelReady = modelPath && MODEL_FILES.every(file => existsSync(join(dirname(modelPath), file)));
    return {
      phase: this.phase, url: this.url, detail: this.detail, pid: this.proc?.pid ?? null,
      reachable: await this.probe(), model: modelReady ? basename(dirname(modelPath!)) : null, profile,
      installed: existsSync(binPath(this.opts.serverDir)) && existsSync(join(this.opts.serverDir, 'FireRedASR2S', 'fireredasr2s', '__init__.py')),
      models: listModels(this.opts.serverDir),
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
    if (want) return isAbsolute(want) ? want : join(this.opts.serverDir, 'models', want);
    const picked = pickModel(this.opts.serverDir);
    return picked ? join(this.opts.serverDir, 'models', picked) : null;
  }
  private resolveLaunch(): { command: string; args: string[]; cwd?: string } | { error: string } {
    if (this.opts.commandOverride) return this.opts.commandOverride;
    const exe = binPath(this.opts.serverDir);
    const source = join(this.opts.serverDir, 'FireRedASR2S');
    if (!existsSync(exe) || !existsSync(join(source, 'fireredasr2s', '__init__.py'))) {
      return { error: `缺文件: FireRed 运行环境未安装(${this.opts.serverDir});运行 scripts/setup-firered-asr.ps1` };
    }
    const model = this.chosenModelPath();
    if (!model) return { error: '缺权重: 请选择 FireRedASR2-AED 的 model.pth.tar' };
    if (!existsSync(model)) return { error: `权重文件不存在: ${model}` };
    if (basename(model) !== 'model.pth.tar') return { error: '请选择 FireRedASR2-AED 的 model.pth.tar' };
    for (const file of MODEL_FILES) {
      if (!existsSync(join(dirname(model), file))) return { error: `缺权重配套文件: ${join(dirname(model), file)}` };
    }
    return { command: exe, cwd: this.opts.serverDir,
      args: [SERVER_SCRIPT, '--host', this.host, '--port', String(this.opts.port()), '--source-dir', source,
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
