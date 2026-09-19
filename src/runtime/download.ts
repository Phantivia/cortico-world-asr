/** Streams one URL to a file, reporting progress; the caller owns the partial-file protocol. */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number | null) => void;
  signal?: AbortSignal;
}

export async function downloadFile(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: options.signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  let done = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      options.onProgress?.(done, total);
      callback(null, chunk);
    },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(dest));
}
