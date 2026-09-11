import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelError, type ModelStatus, type Resource } from './types.js';

export interface DownloadOptions {
  directory: string;
  resources: Resource[];
  onProgress?: (state: Pick<ModelStatus, 'resource' | 'downloadedBytes' | 'totalBytes'>) => void;
  fetch?: typeof fetch;
  freeBytes?: () => Promise<number>;
  reserveBytes?: number;
  signal?: AbortSignal;
}

/** Downloads immutable resources, publishing only complete hash-verified files. */
export class ResourceDownloader {
  private pending?: Promise<void>;
  constructor(private readonly options: DownloadOptions) {}
  prepare(retry = false): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.run(retry).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async run(retry: boolean): Promise<void> {
    const { directory, resources, signal } = this.options;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, '.download-lock');
    let acquired = false;
    for (let i = 0; i < 1200; i++) {
      signal?.throwIfAborted();
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; await writeFile(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const pid = Number(await readFile(path.join(lock, 'pid'), 'utf8'));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') await rm(lock, { recursive: true, force: true }); }
          }
        } catch { if (Date.now() - (await stat(lock)).mtimeMs > 60_000) await rm(lock, { recursive: true, force: true }); }
        await delay(250, undefined, { signal });
      }
    }
    if (!acquired) throw new ModelError('MODEL_PREPARING', 'Another process is still preparing local resources.');
    const failurePath = path.join(directory, '.download-error.json');
    try {
      if (retry) await rm(failurePath, { force: true });
      else {
        const previous = await readFile(failurePath, 'utf8').catch(() => undefined);
        if (previous) { const failure = JSON.parse(previous); throw new ModelError(failure.code, `${failure.message} Explicit model retry is required.`); }
      }
      for (const resource of resources) {
        signal?.throwIfAborted();
        if (path.basename(resource.filename) !== resource.filename || !/^[a-f0-9]{64}$/.test(resource.sha256) || resource.size <= 0) throw new ModelError('DOWNLOAD_FAILED', 'Invalid pinned resource manifest.');
        const destination = path.join(directory, resource.filename);
        if (await validFile(destination, resource)) continue;
        if (await exists(destination)) await rm(destination);
        const partial = `${destination}.part`;
        let offset = (await stat(partial).catch(() => ({ size: 0 }))).size;
        if (offset > resource.size) { await rm(partial); offset = 0; }
        const available = this.options.freeBytes ? await this.options.freeBytes() : await statfs(directory).then(s => s.bavail * s.bsize);
        if (available < resource.size - offset + (this.options.reserveBytes ?? 1024 ** 3)) throw new ModelError('DISK_FULL', `Insufficient disk space for ${resource.filename}; free at least ${resource.size - offset + (this.options.reserveBytes ?? 1024 ** 3)} bytes.`);
        this.options.onProgress?.({ resource: resource.id, downloadedBytes: offset, totalBytes: resource.size });
        if (offset < resource.size) {
          // The 8B artifact can take well over 30 minutes on a normal home
          // connection. User shutdown still aborts immediately via signal.
          const timeout = AbortSignal.timeout(2 * 60 * 60_000);
          const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          const response = await (this.options.fetch ?? fetch)(resource.url, { headers: offset ? { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' }, signal: requestSignal });
          if (!response.ok || !response.body) throw new ModelError('DOWNLOAD_FAILED', `Download of ${resource.filename} failed (HTTP ${response.status}).`);
          if (offset > 0 && response.status === 200) offset = 0;
          if (response.status === 206) {
            const range = response.headers.get('content-range');
            if (!range?.startsWith(`bytes ${offset}-`) || !range.endsWith(`/${resource.size}`)) throw new ModelError('DOWNLOAD_FAILED', `Invalid resume response for ${resource.filename}.`);
          } else if (response.status !== 200) throw new ModelError('DOWNLOAD_FAILED', `Unexpected download status ${response.status}.`);
          const file = await open(partial, offset ? 'a' : 'w', 0o600);
          let lastProgress = 0;
          try {
            for await (const chunk of response.body) {
              signal?.throwIfAborted();
              offset += chunk.byteLength;
              if (offset > resource.size) throw new ModelError('CHECKSUM_MISMATCH', `Download exceeds the pinned size for ${resource.filename}.`);
              await file.writeFile(chunk);
              if (Date.now() - lastProgress > 250) { this.options.onProgress?.({ resource: resource.id, downloadedBytes: offset, totalBytes: resource.size }); lastProgress = Date.now(); }
            }
            await file.sync();
          } finally { await file.close(); }
        }
        if (!await validFile(partial, resource)) {
          // A full but corrupt part cannot be resumed. Keep interrupted shorter files.
          if ((await stat(partial).catch(() => ({ size: 0 }))).size >= resource.size) await rm(partial, { force: true });
          throw new ModelError('CHECKSUM_MISMATCH', `Size or SHA-256 verification failed for ${resource.filename}.`);
        }
        await rename(partial, destination);
        const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
        this.options.onProgress?.({ resource: resource.id, downloadedBytes: resource.size, totalBytes: resource.size });
      }
    } catch (cause) {
      const error = cause instanceof ModelError ? cause : new ModelError((cause as NodeJS.ErrnoException).code === 'ENOSPC' ? 'DISK_FULL' : signal?.aborted ? 'MODEL_STOPPED' : 'DOWNLOAD_FAILED', signal?.aborted ? 'Resource preparation stopped.' : 'Resource download failed; check network and available disk space.', { cause });
      if (!signal?.aborted) {
        const temp = `${failurePath}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify({ code: error.code, message: error.message }), { mode: 0o600 }).then(() => rename(temp, failurePath)).catch(() => undefined);
      }
      throw error;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}

async function exists(filename: string): Promise<boolean> { return stat(filename).then(() => true, () => false); }
async function validFile(filename: string, resource: Resource): Promise<boolean> {
  const info = await stat(filename).catch(() => undefined);
  if (!info?.isFile() || info.size !== resource.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex') === resource.sha256;
}
