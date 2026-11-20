import { spawn } from 'node:child_process';

// Set test-only settings in Node so this script works in PowerShell, cmd, and Unix shells.
const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-timeout=60000', 'tests/*.test.js'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TEST_REDIS_URL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380/15',
    },
    stdio: 'inherit',
  },
);

child.once('error', (error) => {
  console.error('[backend test runner] Could not start Node tests:', error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[backend test runner] Tests stopped by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
