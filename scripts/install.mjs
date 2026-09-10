#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, access, rm, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const flags = process.argv.slice(2);
function option(name, fallback) {
  const index = flags.indexOf(name);
  if (index < 0) return fallback;
  if (!flags[index + 1] || flags[index + 1].startsWith('--')) throw new Error(`Missing value: ${name}`);
  return flags[index + 1];
}
const destination = resolve(option('--destination', join(homedir(), '.local', 'share', 'banana-memory', 'marketplace')));
const scope = option('--scope', 'user');
if (!['user', 'project', 'local'].includes(scope)) throw new Error('Scope must be user, project or local');
const claude = option('--claude', 'claude');
const env = { ...process.env };
const configDir = option('--claude-config-dir', undefined);
if (configDir) env.CLAUDE_CONFIG_DIR = resolve(configDir);
function run(args) {
  const result = spawnSync(claude, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Claude command failed (${result.status})`);
}

if (flags.includes('--uninstall')) {
  run(['plugin', 'uninstall', 'banana-memory@banana-memory-local', '--scope', scope]);
  console.log('Integration removed. Local memory and model files remain in ~/.banana-memory (or BANANA_MEMORY_HOME).');
} else {
  if (process.versions.node !== '22.23.1') throw new Error('Use the pinned Node.js 22.23.1 runtime to build and install this release.');
  const pluginManifest = JSON.parse(await readFile(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  if (pluginManifest.name !== metadata.name || pluginManifest.version !== metadata.version) throw new Error('Plugin manifest name/version must match package.json before packaging or installing.');
  await access(join(root, 'dist', 'src', 'cli.js'));
  await access(join(root, 'node_modules'));
  if (await access(destination).then(() => true, () => false)) {
    const previousManifest = await readFile(join(destination, '.claude-plugin', 'marketplace.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (previousManifest?.name !== 'banana-memory-local') throw new Error('Destination exists and is not a Banana Memory marketplace; choose an empty destination.');
  }
  const stage = `${destination}.stage-${process.pid}`;
  await mkdir(stage, { recursive: true });
  const plugin = join(stage, 'banana-memory');
  await cp(join(root, 'plugin'), plugin, { recursive: true });
  const runtime = join(plugin, 'runtime');
  await mkdir(runtime, { recursive: true });
  for (const file of ['dist', 'models', 'node_modules', 'package.json', 'package-lock.json']) await cp(join(root, file), join(runtime, file), { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(join(root, file), join(plugin, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  // Pin the executable actually used by this local installer; spaces remain separate args.
  const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
  const nodeCommand = flags.includes('--portable-runtime') ? 'node' : process.execPath;
  mcp.mcpServers['banana-memory'].command = nodeCommand;
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) hook.command = nodeCommand;
  await writeFile(join(plugin, 'hooks', 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n');
  await mkdir(join(stage, '.claude-plugin'), { recursive: true });
  await writeFile(join(stage, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'banana-memory-local', owner: { name: 'Banana Memory contributors' },
    metadata: { description: 'Local source installation of the Banana Memory Claude Code plugin.' },
    plugins: [{ name: metadata.name, source: './banana-memory', version: metadata.version, description: 'Local automatic project memory for Claude Code' }],
  }, null, 2) + '\n');
  run(['plugin', 'validate', stage]);
  const previous = `${destination}.previous-${process.pid}`;
  await rename(destination, previous).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rename(stage, destination);
  await rm(previous, { recursive: true, force: true });
  if (!flags.includes('--stage-only')) {
    run(['plugin', 'marketplace', 'add', destination, '--scope', scope]);
    run(['plugin', 'install', 'banana-memory@banana-memory-local', '--scope', scope]);
    console.log('Installed. Restart Claude Code in your project, trust the plugin as prompted, then run /banana-memory:memory status.');
  } else console.log(`Prepared local marketplace: ${destination}`);
}
