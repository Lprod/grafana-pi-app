import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { textResult, throwIfAborted } from './result';
import type {
  InvestigationReport,
  InvestigationReportPatch,
  InvestigationReportRuntime,
  InvestigationReportStatus,
} from './types';

type UpdateReportParams = {
  title?: string;
  patch?: InvestigationReportPatch[];
};

const ARRAY_SECTIONS = ['scope', 'evidence', 'hypotheses', 'ruledOut', 'nextSteps', 'remediation'] as const;
type ArraySection = (typeof ARRAY_SECTIONS)[number];

const MAX_SECTION_ITEMS = 40;
const MAX_ITEM_LENGTH = 600;

export function createInvestigationTools(runtime?: InvestigationReportRuntime): AgentTool[] {
  return [makeUpdateReportTool(runtime)];
}

function makeUpdateReportTool(runtime?: InvestigationReportRuntime): AgentTool {
  return {
    name: 'update_report',
    label: 'Update investigation report',
    description:
      'Update the structured investigation report shown in the chat workspace. Use this during diagnosis to track scope, evidence, hypotheses, ruled-out causes, next checks, and remediation.',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Optional report title. Used when creating a report.' })),
      patch: Type.Optional(
        Type.Array(
          Type.Object({
            op: Type.Union([Type.Literal('add'), Type.Literal('replace'), Type.Literal('remove')]),
            path: Type.String({
              description:
                'JSON Pointer path. Supported paths: /title, /status, /scope, /scope/-, /evidence/-, /hypotheses/-, /ruledOut/-, /nextSteps/-, /remediation/-, or an array index.',
            }),
            value: Type.Optional(
              Type.Union([Type.String(), Type.Array(Type.String())], {
                description: 'String value, or string array when replacing a full report section.',
              })
            ),
          })
        )
      ),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      if (!runtime) {
        throw new Error('Investigation report runtime is not available.');
      }

      const args = params as UpdateReportParams;
      const next = applyReportPatches(runtime.getReport() ?? createEmptyReport(args.title), args.patch ?? []);
      if (args.title?.trim()) {
        next.title = sanitizeItem(args.title.trim(), 160);
      }
      next.updatedAt = new Date().toISOString();
      runtime.setReport(next);

      const summary = {
        status: next.status,
        title: next.title,
        counts: Object.fromEntries(ARRAY_SECTIONS.map((section) => [section, next[section].length])),
        updatedAt: next.updatedAt,
      };

      return textResult(JSON.stringify(summary, null, 2), { type: 'investigationReport', report: next, summary });
    },
  };
}

export function createEmptyReport(title?: string): InvestigationReport {
  const now = new Date().toISOString();
  return {
    id: createReportId(),
    title: sanitizeItem(title?.trim() || 'Investigation report', 160),
    status: 'active',
    scope: [],
    evidence: [],
    hypotheses: [],
    ruledOut: [],
    nextSteps: [],
    remediation: [],
    updatedAt: now,
  };
}

function applyReportPatches(report: InvestigationReport, patches: InvestigationReportPatch[]): InvestigationReport {
  const next = cloneReport(report);

  for (const patch of patches.slice(0, 60)) {
    applyReportPatch(next, patch);
  }

  return next;
}

function applyReportPatch(report: InvestigationReport, patch: InvestigationReportPatch) {
  const path = parsePointer(patch.path);
  if (path.length === 0) {
    throw new Error('update_report patch path must not target the report root.');
  }

  const [field, index] = path;
  if (field === 'title') {
    if (patch.op === 'remove') {
      report.title = 'Investigation report';
      return;
    }
    report.title = sanitizeItem(String(patch.value ?? ''), 160) || 'Investigation report';
    return;
  }

  if (field === 'status') {
    if (patch.op === 'remove') {
      report.status = 'active';
      return;
    }
    report.status = normalizeStatus(patch.value);
    return;
  }

  if (!isArraySection(field)) {
    throw new Error(`update_report does not support path /${field}.`);
  }

  applyArrayPatch(report[field], index, patch);
}

function applyArrayPatch(section: string[], index: string | undefined, patch: InvestigationReportPatch) {
  if (index === undefined) {
    if (patch.op === 'remove') {
      section.splice(0);
      return;
    }
    const values = Array.isArray(patch.value) ? patch.value : [patch.value];
    section.splice(0, section.length, ...sanitizeItems(values));
    return;
  }

  if (index === '-') {
    if (patch.op === 'remove') {
      throw new Error('update_report cannot remove from /-/ append path.');
    }
    section.push(...sanitizeItems([patch.value]));
    trimSection(section);
    return;
  }

  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex > section.length) {
    throw new Error(`update_report array index is out of range: ${index}`);
  }

  if (patch.op === 'remove') {
    if (numericIndex >= section.length) {
      throw new Error(`update_report cannot remove missing array index: ${index}`);
    }
    section.splice(numericIndex, 1);
    return;
  }

  const values = sanitizeItems([patch.value]);
  if (patch.op === 'add') {
    section.splice(numericIndex, 0, ...values);
  } else {
    section.splice(numericIndex, 1, ...values);
  }
  trimSection(section);
}

function sanitizeItems(values: unknown[]) {
  return values.map((value) => sanitizeItem(String(value ?? ''), MAX_ITEM_LENGTH)).filter(Boolean);
}

function sanitizeItem(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function trimSection(section: string[]) {
  if (section.length > MAX_SECTION_ITEMS) {
    section.splice(0, section.length - MAX_SECTION_ITEMS);
  }
}

function normalizeStatus(value: unknown): InvestigationReportStatus {
  return value === 'complete' ? 'complete' : 'active';
}

function parsePointer(path: string) {
  if (!path.startsWith('/')) {
    throw new Error(`update_report path must be a JSON Pointer starting with /: ${path}`);
  }
  return path
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isArraySection(value: string): value is ArraySection {
  return (ARRAY_SECTIONS as readonly string[]).includes(value);
}

function cloneReport(report: InvestigationReport): InvestigationReport {
  return {
    ...report,
    scope: [...report.scope],
    evidence: [...report.evidence],
    hypotheses: [...report.hypotheses],
    ruledOut: [...report.ruledOut],
    nextSteps: [...report.nextSteps],
    remediation: [...report.remediation],
  };
}

function createReportId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `investigation-${Date.now().toString(36)}`;
}
