import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = listFiles(process.cwd()).filter((file) => /\.(mjs|js)$/.test(file));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (['sources', 'node_modules', '.git', 'dist', 'test-results'].includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
