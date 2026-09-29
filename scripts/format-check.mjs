import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = listFiles(process.cwd()).filter((file) => /\.(mjs|json|md|sql)$/.test(file));
const offenders = files.filter((file) => /\t|[ \t]$/m.test(readFileSync(file, 'utf8')));
if (offenders.length > 0) {
  console.error(`Formatting check failed:\n${offenders.join('\n')}`);
  process.exit(1);
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (
      name === 'sources' ||
      name === 'node_modules' ||
      name === '.git' ||
      name === 'dist' ||
      name === 'test-results' ||
      name === 'playwright-report'
    )
      return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
