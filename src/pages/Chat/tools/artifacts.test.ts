jest.mock('typebox', () => ({
  Type: {
    Literal: jest.fn((value, config) => ({ ...config, const: value })),
    Number: jest.fn((config) => config ?? {}),
    Object: jest.fn((properties) => ({ properties })),
    Optional: jest.fn((schema) => schema),
    String: jest.fn((config) => config ?? {}),
    Union: jest.fn((items, config) => ({ ...config, items })),
  },
}));

import {
  artifactizeToolResult,
  createArtifactTools,
  type Artifact,
  type ArtifactRuntime,
  type RegisterArtifactInput,
} from './artifacts';

describe('artifact tools', () => {
  it('stores bulky tool results behind an artifact handle', () => {
    const { runtime, artifacts } = createTestArtifactRuntime();
    const rows = Array.from({ length: 400 }, (_, index) => ({ id: index, value: `row-${index}` }));
    const result = artifactizeToolResult(runtime, 'query_prometheus', {
      content: [{ type: 'text', text: JSON.stringify({ rows }, null, 2) }],
      details: { rows: rows.length },
    });

    const firstBlock = result?.content?.[0];
    expect(result).toBeDefined();
    expect(firstBlock).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Stored artifact [artifact: artifact_1]'),
    });
    expect(result?.details).toMatchObject({
      rows: rows.length,
      artifactRef: {
        id: 'artifact_1',
        kind: 'json',
        toolName: 'query_prometheus',
      },
    });
    expect(artifacts.artifact_1.data).toMatchObject({ rows: expect.any(Array) });
  });

  it('skips artifactization when a tool result has no content array', () => {
    const { runtime } = createTestArtifactRuntime();

    expect(() =>
      artifactizeToolResult(runtime, 'search_dashboard_metric_usage', {
        details: { summarized: true },
      } as any)
    ).not.toThrow();
    expect(
      artifactizeToolResult(runtime, 'search_dashboard_metric_usage', {
        details: { summarized: true },
      } as any)
    ).toBeUndefined();
  });

  it('reads fields, slices, and jq output from stored artifacts', async () => {
    const { runtime } = createTestArtifactRuntime();
    const stored = runtime.register({
      kind: 'json',
      title: 'query_prometheus',
      toolName: 'query_prometheus',
      summary: 'Prometheus batch result.',
      data: {
        results: [
          { query: 'up', series: [{ name: 'up', value: 1 }] },
          { query: 'rate(http_requests_total[5m])', series: [{ name: 'http_requests_total', value: 2 }] },
        ],
      },
    });
    const [tool] = createArtifactTools(runtime);

    const field = await tool.execute('call-1', { id: stored.id, mode: 'field', path: 'results.0.query' }, undefined);
    expect(textContent(field)).toBe('up');

    const slice = await tool.execute('call-2', { id: stored.id, mode: 'slice', path: 'results', limit: 1 }, undefined);
    expect(JSON.parse(textContent(slice))).toEqual([{ query: 'up', series: [{ name: 'up', value: 1 }] }]);

    const jq = await tool.execute('call-3', { id: stored.id, mode: 'jq', jq: '.results | length' }, undefined);
    expect(textContent(jq).trim()).toBe('2');
    expect(jq.details).toMatchObject({ artifactRead: true, mode: 'jq', exitCode: 0 });
  });
});

function createTestArtifactRuntime() {
  const artifacts: Record<string, Artifact> = {};
  let counter = 0;
  const runtime: ArtifactRuntime = {
    register: (input: RegisterArtifactInput) => {
      counter += 1;
      const id = `artifact_${counter}`;
      const artifact: Artifact = {
        id,
        kind: input.kind,
        title: input.title,
        toolName: input.toolName,
        createdAt: '2026-06-05T00:00:00.000Z',
        bytes: input.bytes ?? JSON.stringify(input.data).length,
        summary: input.summary,
        data: input.data,
        preview: input.preview,
        mimeType: input.mimeType,
        toolDetails: input.toolDetails,
      };
      artifacts[id] = artifact;
      return artifact;
    },
    get: (id) => artifacts[id],
    list: () => Object.values(artifacts),
  };

  return { runtime, artifacts };
}

function textContent(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  return block.type === 'text' ? (block.text ?? '') : '';
}
