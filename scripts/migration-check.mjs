import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const migrationDir = join(process.cwd(), 'db', 'migrations');
const bootstrapDir = join(process.cwd(), 'db', 'bootstrap');
const ups = readdirSync(migrationDir).filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql')).sort();
const problems = [];

for (const up of ups) {
  const down = up.replace('.sql', '.down.sql');
  const upPath = join(migrationDir, up);
  const downPath = join(migrationDir, down);
  const sql = readFileSync(upPath, 'utf8');
  if (!/^begin;/i.test(sql.trim())) problems.push(`${up} must start with begin`);
  if (!/commit;/i.test(sql)) problems.push(`${up} must commit`);
  if (/enable row level security/i.test(sql) && !/create policy/i.test(sql)) problems.push(`${up} enables RLS without policies`);
  if (/create policy/i.test(sql) && !/with check/i.test(sql)) problems.push(`${up} has RLS policies without explicit WITH CHECK`);
  if (!existsSync(downPath)) problems.push(`${up} is missing rollback ${down}`);
}

const bootstrapFiles = existsSync(bootstrapDir) ? readdirSync(bootstrapDir).filter((name) => name.endsWith('.sql')) : [];
const bootstrapSql = bootstrapFiles.map((name) => readFileSync(join(bootstrapDir, name), 'utf8')).join('\n');
if (!/nobypassrls/i.test(bootstrapSql)) problems.push('runtime database role must use NOBYPASSRLS');
if (/grant\s+all/i.test(bootstrapSql)) problems.push('runtime database role must not receive GRANT ALL');

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
