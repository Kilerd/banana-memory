export type RuntimeName = 'node' | 'npm' | 'pnpm' | 'python';

/** Shared names for host observations and model-extracted applicability fields. */
export function normalizeRuntimeName(name: string): RuntimeName | undefined {
  const aliases: Readonly<Record<string, RuntimeName>> = {
    node: 'node', 'node.js': 'node', nodejs: 'node', npm: 'npm', pnpm: 'pnpm', python: 'python', python3: 'python',
  };
  const key = name.trim().toLowerCase();
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}
