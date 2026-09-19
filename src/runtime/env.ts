/**
 * The FireRedASR2-AED runtime is a Python environment: a pinned checkout of the upstream
 * inference code plus a virtualenv with PyTorch and the pinned requirements. It installs to
 * `<runtimes root>/firered-asr/<revision>/<key>/`, built inside `<dir>.partial` and renamed into
 * place once `cortico-runtime.json` is written. The steps run `git` and `uv` from PATH; the
 * package installs neither, nor the NVIDIA driver the CUDA wheels need.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';

export const RUNTIME_ID = 'firered-asr';
export const RUNTIME_MARKER = 'cortico-runtime.json';
/** Upstream inference code this package was verified against; `backend.runtimeRevision` may pin another. */
export const PINNED_SOURCE_REVISION = '4e7d9aaf4482a47cec1724807026b9b151926eb5';
export const SOURCE_REPO = 'https://github.com/FireRedTeam/FireRedASR2S.git';
export const PYTHON_VERSION = '3.12';
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';
const TORCH_PACKAGES = ['torch==2.9.1+cu128', 'torchaudio==2.9.1+cu128', 'torchvision==0.24.1+cu128'];
const REQUIREMENTS = fileURLToPath(new URL('../firered-requirements.txt', import.meta.url));

export interface EnvPlan {
  /** Directory name under the revision; names the wheel index the environment was built from. */
  key: string;
}

/** Platforms with cu128 wheels on the PyTorch index; the same wheels serve the cpu profile. */
export function envPlan(platform: NodeJS.Platform = process.platform): EnvPlan | null {
  return platform === 'win32' || platform === 'linux' ? { key: 'cu128' } : null;
}

export function pythonExe(dir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python');
}

export function sourceDir(dir: string): string {
  return join(dir, 'FireRedASR2S');
}

/** A directory the server can run from, managed or self-provided. */
export function runtimeUsable(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  return existsSync(pythonExe(dir, platform)) && existsSync(join(sourceDir(dir), 'fireredasr2s', '__init__.py'));
}

export type InstallPhase = 'absent' | 'installing' | 'installed' | 'error';

export interface InstallState {
  phase: InstallPhase;
  /** Step in progress. */
  step: string | null;
  /** Last line the step printed. */
  line: string | null;
  detail: string | null;
}

export interface RuntimeMarker {
  runtime: typeof RUNTIME_ID;
  revision: string;
  key: string;
  python: string;
  torch: string[];
  installedAt: string;
}

export interface CommandRun {
  command: string;
  args: string[];
  cwd?: string;
  onLine: (line: string) => void;
}
/** Resolves with the exit code; rejects only when the process cannot be spawned. */
export type CommandRunner = (run: CommandRun) => Promise<number>;

interface Step {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
}

export function installSteps(partial: string, revision: string): Step[] {
  const source = sourceDir(partial);
  const python = pythonExe(partial);
  return [
    { name: '取上游代码', command: 'git', args: ['clone', SOURCE_REPO, source] },
    { name: '钉住代码版本', command: 'git', args: ['-C', source, 'checkout', '--detach', revision] },
    { name: '建 Python 环境', command: 'uv', args: ['venv', '--python', PYTHON_VERSION, join(partial, '.venv')] },
    { name: '装 PyTorch', command: 'uv', args: ['pip', 'install', '--python', python, ...TORCH_PACKAGES, '--index-url', TORCH_INDEX] },
    { name: '装依赖', command: 'uv', args: ['pip', 'install', '--python', python, '-r', REQUIREMENTS] },
  ];
}

export const spawnRunner: CommandRunner = (run) => new Promise((resolve, reject) => {
  const child = spawn(run.command, run.args, {
    cwd: run.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', PYTHONUTF8: '1' },
  });
  let pending = '';
  const feed = (chunk: Buffer): void => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n|\r/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) run.onLine(line.trim());
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  child.once('error', reject);
  child.once('exit', (code) => {
    if (pending.trim()) run.onLine(pending.trim());
    resolve(code ?? -1);
  });
});

export class RuntimeStore {
  private active: { dir: string; step: string; line: string | null } | null = null;
  private readonly failures = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly log: Logger,
    private readonly runner: CommandRunner = spawnRunner,
  ) {}

  dir(revision: string, plan: EnvPlan): string {
    return join(this.root, RUNTIME_ID, revision.slice(0, 12), plan.key);
  }

  installed(dir: string): boolean {
    return existsSync(join(dir, RUNTIME_MARKER));
  }

  marker(dir: string): RuntimeMarker | null {
    try {
      return JSON.parse(readFileSync(join(dir, RUNTIME_MARKER), 'utf8')) as RuntimeMarker;
    } catch {
      return null;
    }
  }

  state(dir: string): InstallState {
    if (this.active?.dir === dir) return { phase: 'installing', step: this.active.step, line: this.active.line, detail: null };
    const failure = this.failures.get(dir);
    if (failure) return { phase: 'error', step: null, line: null, detail: failure };
    return { phase: this.installed(dir) ? 'installed' : 'absent', step: null, line: null, detail: null };
  }

  /** Runs every step into `<dir>.partial`; a second concurrent install is refused. */
  async install(revision: string, plan: EnvPlan): Promise<void> {
    const dir = this.dir(revision, plan);
    if (this.active) throw new Error('已经有一个运行时在安装了,等它结束');
    this.failures.delete(dir);
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    this.active = { dir, step: '', line: null };
    try {
      for (const step of installSteps(partial, revision)) {
        this.active = { dir, step: step.name, line: null };
        this.log.info(`识别运行时 ${step.name}: ${step.command} ${step.args.join(' ')}`);
        const tail: string[] = [];
        let code: number;
        try {
          code = await this.runner({
            command: step.command, args: step.args, cwd: step.cwd,
            onLine: (line) => {
              if (this.active?.dir === dir) this.active.line = line;
              tail.push(line);
              if (tail.length > 20) tail.shift();
            },
          });
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          throw new Error(err.code === 'ENOENT'
            ? `${step.name}失败: 找不到 ${step.command},装好并放进 PATH 后重试`
            : `${step.name}失败: ${err.message}`);
        }
        if (code !== 0) throw new Error(`${step.name}失败(${step.command} 退出码 ${code}): ${tail.slice(-3).join(' | ')}`);
      }
      const marker: RuntimeMarker = {
        runtime: RUNTIME_ID, revision, key: plan.key, python: PYTHON_VERSION, torch: TORCH_PACKAGES,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(join(partial, RUNTIME_MARKER), JSON.stringify(marker, null, 2) + '\n');
      mkdirSync(join(dir, '..'), { recursive: true });
      renameSync(partial, dir);
      this.log.info(`识别运行时已安装 ${dir}`);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      this.failures.set(dir, detail);
      this.log.warn(`识别运行时安装失败: ${detail}`);
      throw error instanceof Error ? error : new Error(detail);
    } finally {
      this.active = null;
    }
  }
}
