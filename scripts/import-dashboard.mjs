#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_GRAFANA_URL = 'http://localhost:3001';

await main();

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.inputPath) {
    printUsage();
    throw new Error('A dashboard JSON file is required.');
  }

  const source = await readDashboardFile(options.inputPath);
  const dashboard = source.dashboard ?? source;
  if (!isObject(dashboard) || typeof dashboard.title !== 'string' || dashboard.title.trim() === '') {
    throw new Error('The input must be a dashboard model or an export containing a dashboard with a title.');
  }

  const grafanaUrl = (options.grafanaUrl ?? process.env.GRAFANA_URL ?? DEFAULT_GRAFANA_URL).replace(/\/+$/, '');
  const payload = {
    dashboard: { ...dashboard, id: null },
    overwrite: options.overwrite,
    message: `Imported from ${options.inputPath}`,
    ...(options.folderUid ? { folderUid: options.folderUid } : {}),
  };

  const response = await fetch(`${grafanaUrl}/api/dashboards/db`, {
    method: 'POST',
    headers: {
      Authorization: authorizationHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  const result = parseJson(responseText);
  if (!response.ok) {
    const detail = result?.message ?? responseText;
    throw new Error(`Grafana dashboard import failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  const dashboardPath = result?.url ?? (result?.uid ? `/d/${encodeURIComponent(result.uid)}` : undefined);
  console.log(`Imported "${dashboard.title}" (${result?.uid ?? dashboard.uid ?? 'unknown UID'}).`);
  if (dashboardPath) {
    console.log(new URL(dashboardPath, `${grafanaUrl}/`).toString());
  }
}

function parseArguments(args) {
  const options = {
    grafanaUrl: undefined,
    folderUid: process.env.GRAFANA_FOLDER_UID,
    help: false,
    inputPath: undefined,
    overwrite: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--grafana-url':
        options.grafanaUrl = requireValue(args, ++index, argument);
        break;
      case '--folder-uid':
        options.folderUid = requireValue(args, ++index, argument);
        break;
      case '--no-overwrite':
        options.overwrite = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (argument.startsWith('-')) {
          throw new Error(`Unknown option: ${argument}`);
        }
        if (options.inputPath) {
          throw new Error(`Unexpected additional dashboard file: ${argument}`);
        }
        options.inputPath = argument;
    }
  }

  return options;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

async function readDashboardFile(inputPath) {
  let contents;
  try {
    contents = await readFile(inputPath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${inputPath}: ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${inputPath} as JSON: ${error.message}`);
  }
}

function authorizationHeader() {
  if (process.env.GRAFANA_TOKEN) {
    return `Bearer ${process.env.GRAFANA_TOKEN}`;
  }
  const user = process.env.GRAFANA_USER ?? 'admin';
  const password = process.env.GRAFANA_PASSWORD ?? 'admin';
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function printUsage() {
  console.log(`Usage: npm run dev:import:dashboard -- [options] <dashboard.json>

Options:
  --grafana-url URL  Grafana URL (default: GRAFANA_URL or ${DEFAULT_GRAFANA_URL})
  --folder-uid UID   Import into an existing Grafana folder (default: General)
  --no-overwrite     Fail instead of replacing a dashboard with the same UID
  -h, --help         Show this help

Authentication:
  Set GRAFANA_TOKEN, or GRAFANA_USER and GRAFANA_PASSWORD (defaults: admin/admin).`);
}
