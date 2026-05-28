import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { pluginResourceFetch } from './client';
import { textResult, throwIfAborted, truncateText } from './result';
import type { JsonnetLibListParams, JsonnetLibReadParams, JsonnetLibSearchParams, JsonnetLibToolSet } from './types';

export function createJsonnetLibTools(): JsonnetLibToolSet {
  const search = makeSearchJsonnetLibsTool();
  const read = makeReadJsonnetLibTool();
  const list = makeListJsonnetLibsTool();

  return {
    all: [search, read, list],
    search,
    read,
    list,
  };
}

function makeSearchJsonnetLibsTool(): AgentTool {
  return {
    name: 'search_grafonnet',
    label: 'Search Jsonnet libraries',
    description: 'Search vendored Grafonnet/Jsonnet library and documentation files for API names and examples.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Plain text search pattern, at least 2 characters.' }),
      path: Type.Optional(Type.String({ description: 'Optional vendored library path prefix, such as github.com/grafana/grafonnet/gen/grafonnet-v11.4.0/panel.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as JsonnetLibSearchParams;
      throwIfAborted(signal);
      const result = await pluginResourceFetch<unknown>('/jsonnet-libs/search', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(result, null, 2), 80000), { pattern: args.pattern });
    },
  };
}

function makeReadJsonnetLibTool(): AgentTool {
  return {
    name: 'read_grafonnet',
    label: 'Read Jsonnet library file',
    description: 'Read a range of lines from a vendored Grafonnet/Jsonnet library or documentation file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Vendored library path, such as github.com/grafana/grafonnet/gen/grafonnet-v11.4.0/docs/panel/timeSeries/index.md.' }),
      offset: Type.Optional(Type.Number({ description: '1-based start line. Defaults to 1.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines. Defaults to 200 and caps at 500.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as JsonnetLibReadParams;
      throwIfAborted(signal);
      const result = await pluginResourceFetch<unknown>('/jsonnet-libs/read', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(result, null, 2), 80000), { path: args.path });
    },
  };
}

function makeListJsonnetLibsTool(): AgentTool {
  return {
    name: 'list_grafonnet',
    label: 'List Jsonnet library files',
    description: 'List vendored .libsonnet files under a Grafonnet/Jsonnet library path.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Optional vendored library path prefix. Defaults to Grafonnet v11.4.0.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as JsonnetLibListParams;
      throwIfAborted(signal);
      const result = await pluginResourceFetch<unknown>('/jsonnet-libs/list', { method: 'POST', data: args });
      return textResult(truncateText(JSON.stringify(result, null, 2), 80000), { path: args.path });
    },
  };
}
