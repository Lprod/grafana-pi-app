#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn(process.execPath, ['scripts/benchmark-agent.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    BENCH_LABEL: process.env.BENCH_LABEL ?? 'dashboard context repair benchmark',
    BENCH_LOG_PREFIX: process.env.BENCH_LOG_PREFIX ?? 'dashboard-context-benchmark',
    BENCH_TEST_FILE: process.env.BENCH_TEST_FILE ?? 'tests/agentDashboardContextBenchmark.spec.ts',
    BENCH_TIMEOUT_MS: process.env.BENCH_TIMEOUT_MS ?? '240000',
  },
});

child.on('error', (error) => {
  throw error;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
