/**
 * Real-service check: install the runtime, download the weights, start the server, transcribe
 * one synthetic WAV. Network, git, uv and a GPU are required; run by hand.
 *
 *   tsx scripts/check-asr-runtime.ts [--root <deployment root>] [--port 8799] [--cpu] [--keep]
 *
 * Everything lands under `scratch/asr-runtime-check/` by default and never touches a deployment.
 * `--keep` leaves the server running for further manual requests.
 */
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { nullLogger } from 'cortico/core/util.ts';
import { AsrServerManager } from '../src/asr-server.ts';
import { PINNED_SOURCE_REVISION, RuntimeStore, envPlan } from '../src/runtime/env.ts';
import { MODEL_NAME, ModelStore } from '../src/runtime/models.ts';

const arg = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const root = resolve(arg('--root', join(process.cwd(), 'scratch', 'asr-runtime-check')));
const port = Number(arg('--port', '8799'));
const profile = argv.includes('--cpu') ? 'cpu' : 'gpu';
const keep = argv.includes('--keep');

const log = {
  ...nullLogger(),
  info: (msg: string) => console.log(`  ${msg}`),
  warn: (msg: string) => console.warn(`  ! ${msg}`),
  child: () => log,
} as unknown as ConstructorParameters<typeof RuntimeStore>[1];

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** 16 kHz mono PCM16 WAV: one second of a 220 Hz tone. */
function toneWav(): Buffer {
  const rate = 16000;
  const samples = rate;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 0.3 * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main(): Promise<void> {
  const plan = envPlan();
  if (!plan) throw new Error(`这个平台(${process.platform})没有托管安装方案`);
  const runtimes = join(root, 'runtimes');
  const modelsDir = join(root, 'models', 'asr');

  step(`运行时 ${PINNED_SOURCE_REVISION.slice(0, 12)} / ${plan.key}`);
  const runtimeStore = new RuntimeStore(runtimes, log);
  const dir = runtimeStore.dir(PINNED_SOURCE_REVISION, plan);
  if (runtimeStore.installed(dir)) console.log(`  已装: ${dir}`);
  else await runtimeStore.install(PINNED_SOURCE_REVISION, plan);

  step('权重');
  const modelStore = new ModelStore(join(modelsDir, MODEL_NAME), log);
  if (modelStore.complete()) console.log(`  已齐: ${modelStore.dir}`);
  else await modelStore.downloadMissing();

  step(`server :${port} (${profile})`);
  const server = new AsrServerManager({
    runtimeDir: () => dir, modelsDir, port: () => port, profile: () => profile,
    modelFile: () => '', threads: () => 0, log, healthIntervalMs: 2000, healthTimeoutMs: 600_000,
  });
  const started = await server.start();
  if (started.phase === 'error') throw new Error(started.detail ?? '起不来');
  while (server.currentPhase === 'starting') await new Promise((r) => setTimeout(r, 2000));
  if (server.currentPhase !== 'running') throw new Error(`server ${server.currentPhase}: ${(await server.state()).detail}`);
  console.log(`  就绪 ${server.url}`);

  step('转写');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(toneWav())], { type: 'audio/wav' }), 'tone.wav');
  const res = await fetch(`${server.url}/v1/audio/transcriptions`, { method: 'POST', body: form });
  console.log(`  HTTP ${res.status}: ${await res.text()}`);

  if (keep) {
    console.log('\n--keep:server 留着,Ctrl+C 结束');
    await new Promise(() => {});
  }
  await server.stop();
}

main().then(() => exit(0), (error) => {
  console.error(`\n失败: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});
