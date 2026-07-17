/** Build first, then apply backward-compatible migrations before promotion. */
import { spawnSync } from 'node:child_process';

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npx', ['next', 'build']);

if (process.env.VERCEL_ENV === 'production') {
  const required = [
    'DATABASE_HOST',
    'DATABASE_NAME',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
  ];
  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Production migration environment is incomplete: ${missing.join(', ')}`);
  }
  run('npm', ['run', 'db:migrate']);
}
