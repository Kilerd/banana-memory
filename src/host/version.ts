import { readFile } from 'node:fs/promises';

/** Resolve the bundled package manifest in both source and compiled layouts. */
export async function releaseMetadata(): Promise<{ name: string; version: string }> {
  for (const relative of ['../../package.json', '../../../package.json']) {
    try {
      const metadata = JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')) as { name?: unknown; version?: unknown };
      if (metadata.name === 'banana-memory' && typeof metadata.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)) return { name: metadata.name, version: metadata.version };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('release_metadata_unavailable');
}
