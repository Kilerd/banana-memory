#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const name = `banana-memory-${metadata.version}-${process.platform}-${process.arch}`;
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const stageResult = spawnSync(process.execPath, ['scripts/install.mjs', '--stage-only', '--portable-runtime', '--destination', join(artifacts, name)], { cwd: root, stdio: 'inherit' });
if (stageResult.error) throw stageResult.error;
if (stageResult.status !== 0) throw new Error(`Packaging failed (${stageResult.status})`);
await writeFile(join(artifacts, name, 'INSTALL.md'), `# Banana Memory ${metadata.version}\n\nThis local Claude Code marketplace bundles the plugin, hooks, Skill, MCP server and ${process.platform}/${process.arch} dependencies. Require Node.js 22.23.1 on PATH. Claude Code host validation uses 2.1.231.\n\nFrom the parent of this extracted directory:\n\n\`\`\`sh\nclaude plugin marketplace add ./${name}\nclaude plugin install banana-memory@banana-memory-local\n\`\`\`\n\nRestart Claude Code inside your project, accept its normal trust prompts, then run /banana-memory:memory status. The first start downloads the pinned local model weights and runtime. Consult the source installation page for download size and measured hardware limitations. Memory and model files live in ~/.banana-memory, outside the plugin cache.\n\nTo explicitly retry a failed resource download, leave this command running until it finishes:\n\n\`\`\`sh\nnode ./${name}/banana-memory/runtime/dist/src/cli.js models-retry\n\`\`\`\n\nUninstall the integration with \`claude plugin uninstall banana-memory@banana-memory-local\`. Memory and model files are retained. This archive contains no cloud model credentials, user memory, or downloaded model weights. It does not include the source-only scripts/install.mjs.\n`);
for (const [command, args] of [
  ['tar', ['-czf', join(artifacts, `${name}.tar.gz`), '-C', artifacts, name]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaging failed (${result.status})`);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(join(artifacts, `${name}.tar.gz`))) hash.update(chunk);
await writeFile(join(artifacts, `${name}.tar.gz.sha256`), `${hash.digest('hex')}  ${name}.tar.gz\n`);
console.log(`Local release created: ${join(artifacts, `${name}.tar.gz`)}`);
console.log('The archive bundles platform-specific dependencies and requires Node.js 22.23.1 on PATH. Models are downloaded at first run.');
