#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn(process.execPath, ['scripts/benchmark-agent.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    BENCH_DEV_RELOAD_TASK: process.env.BENCH_DEV_RELOAD_TASK ?? 'dev:reload:variant',
    BENCH_LABEL: process.env.BENCH_LABEL ?? 'dashboard plan handoff benchmark',
    BENCH_LOG_PREFIX: process.env.BENCH_LOG_PREFIX ?? 'dashboard-plan-handoff-benchmark',
    BENCH_TEST_FILE: process.env.BENCH_TEST_FILE ?? 'tests/agentDashboardPlanHandoffBenchmark.spec.ts',
    BENCH_TIMEOUT_MS: process.env.BENCH_TIMEOUT_MS ?? '420000',
    E2E_PLUGIN_ID: process.env.E2E_PLUGIN_ID ?? 'grafana-assistant-app',
    GRAFANA_URL: process.env.GRAFANA_URL ?? 'http://localhost:3001',
    HISTORY_FUTURE_SECONDS: process.env.HISTORY_FUTURE_SECONDS ?? '3600',
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
