/**
 * FireRedASR2-AED weights: four files from one HuggingFace revision, stored together in
 * `<models root>/asr/FireRedASR2-AED/`. Each file downloads to `<file>.partial` and is renamed
 * into place, so an interrupted download never passes for a complete one.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { downloadFile } from './download.ts';

export const MODEL_REPO = 'FireRedTeam/FireRedASR2-AED';
export const MODEL_REVISION = '2304afed56eacfee6256dee5937ed22ffa0b64ec';
/** Directory name under `<models root>/asr/`; also the model label the server reports. */
export const MODEL_NAME = 'FireRedASR2-AED';

export interface ModelFileSpec {
  file: string;
  /** Approximate size for progress display; not verified. */
  approxBytes: number;
}

/** Every file the server needs next to `model.pth.tar`. */
export const MODEL_FILES: readonly ModelFileSpec[] = [
  { file: 'model.pth.tar', approxBytes: 4_731_558_506 },
  { file: 'cmvn.ark', approxBytes: 1_311 },
  { file: 'dict.txt', approxBytes: 79_172 },
  { file: 'train_bpe1000.model', approxBytes: 251_707 },
];

export function modelFileUrl(file: string): string {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file}`;
}

export type ModelPhase = 'absent' | 'downloading' | 'present' | 'error';

export interface ModelFileState {
  file: string;
  path: string;
  phase: ModelPhase;
  bytes: number;
  done: number;
  total: number | null;
  detail: string | null;
}

export class ModelStore {
  private active: { file: string; done: number; total: number | null } | null = null;
  private readonly failures = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly dir: string,
    private readonly log: Logger,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  path(file: string): string {
    return join(this.dir, file);
  }

  /** The set is usable only when every file is present. */
  complete(): boolean {
    return MODEL_FILES.every((spec) => existsSync(this.path(spec.file)));
  }

  get source(): string {
    return `${MODEL_REPO}@${MODEL_REVISION.slice(0, 7)}`;
  }

  states(): ModelFileState[] {
    return MODEL_FILES.map((spec) => {
      const path = this.path(spec.file);
      const here = existsSync(path);
      const base: ModelFileState = {
        file: spec.file, path, phase: here ? 'present' : 'absent',
        bytes: here ? statSync(path).size : 0, done: 0, total: null, detail: null,
      };
      if (this.active?.file === spec.file) {
        return { ...base, phase: 'downloading', done: this.active.done, total: this.active.total ?? spec.approxBytes };
      }
      const failure = this.failures.get(spec.file);
      if (failure) return { ...base, phase: 'error', detail: failure };
      return base;
    });
  }

  /** Downloads every missing file in order; a second concurrent download is refused. */
  async downloadMissing(): Promise<void> {
    if (this.active) throw new Error('已经有一个权重在下载了,等它结束');
    mkdirSync(this.dir, { recursive: true });
    for (const spec of MODEL_FILES) {
      const dest = this.path(spec.file);
      if (existsSync(dest)) continue;
      this.failures.delete(spec.file);
      const partial = `${dest}.partial`;
      rmSync(partial, { force: true });
      this.active = { file: spec.file, done: 0, total: null };
      this.log.info(`识别权重下载 ${modelFileUrl(spec.file)}`);
      try {
        await downloadFile(modelFileUrl(spec.file), partial, {
          fetchImpl: this.fetchImpl,
          onProgress: (done, total) => {
            if (this.active?.file === spec.file) Object.assign(this.active, { done, total });
          },
        });
        renameSync(partial, dest);
        this.log.info(`识别权重已就位 ${dest}`);
      } catch (error) {
        rmSync(partial, { force: true });
        const detail = error instanceof Error ? error.message : String(error);
        this.failures.set(spec.file, detail);
        this.log.warn(`识别权重下载失败 ${spec.file}: ${detail}`);
        throw new Error(`下载 ${spec.file} 失败: ${detail}`);
      } finally {
        this.active = null;
      }
    }
  }
}
