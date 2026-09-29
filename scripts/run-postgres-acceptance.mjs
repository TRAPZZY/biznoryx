import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const databaseUrl = process.env.DATABASE_URL;
const dockerPath = process.env.DOCKER_BIN ?? 'docker';

if (!databaseUrl) {
  console.error('DATABASE_URL is required to run PostgreSQL acceptance tests.');
  process.exit(2);
}

if (!existsSync('db/acceptance')) {
  console.error('Missing database acceptance SQL directory.');
  process.exit(1);
}

const files = [
  ...sqlFiles('db/migrations').filter((file) => !file.endsWith('.down.sql')),
  ...sqlFiles('db/bootstrap'),
  ...sqlFiles('db/acceptance')
];

for (const file of files) {
  const args = [databaseUrl, '-v', 'ON_ERROR_STOP=1'];
  if (file.includes('bootstrap')) {
    args.push('-v', `biznoryx_app_password=${process.env.BIZNORYX_APP_DB_PASSWORD ?? 'local_runtime_password_change_me'}`);
  }
  args.push('-f', file);
  runPsql(file, args);
}

function runPsql(file, args) {
  const hostResult = spawnSync('psql', args, {
    stdio: 'inherit'
  });

  if (!hostResult.error && hostResult.status === 0) return;
  if (!hostResult.error) process.exit(hostResult.status ?? 1);
  if (hostResult.error.code !== 'ENOENT') {
    console.error(hostResult.error.message);
    process.exit(2);
  }

  const dockerArgs = [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    databaseUrl,
    '-v',
    'ON_ERROR_STOP=1'
  ];
  if (file.includes('bootstrap')) {
    dockerArgs.push('-v', `biznoryx_app_password=${process.env.BIZNORYX_APP_DB_PASSWORD ?? 'local_runtime_password_change_me'}`);
  }
  dockerArgs.push('-f', '-');

  const dockerResult = spawnSync(dockerPath, dockerArgs, {
    input: readFileSync(file),
    stdio: ['pipe', 'inherit', 'inherit']
  });
  if (dockerResult.error) {
    console.error(dockerResult.error.message);
    process.exit(2);
  }
  if (dockerResult.status !== 0) process.exit(dockerResult.status ?? 1);
}

function sqlFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(dir, name));
}
