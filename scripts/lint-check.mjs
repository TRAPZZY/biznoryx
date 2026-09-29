import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = listFiles(process.cwd()).filter((file) => /\.(mjs|sql)$/.test(file));
const banned = [
  /role\s*===/,
  /select\s+\*\s+from/i,
  /console\.log\(/
];

const findings = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const pattern of banned) {
    if (pattern.test(content)) findings.push(`${file}: banned pattern ${pattern}`);
  }
}

if (findings.length > 0) {
  console.error(findings.join('\n'));
  process.exit(1);
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'sources' || name === 'node_modules' || name === '.git') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
