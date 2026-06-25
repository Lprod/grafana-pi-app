#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.join(root, 'assets');
const iconDir = path.join(assetDir, 'icons');

const colors = {
  bg: '#f4fbfe',
  white: '#ffffff',
  stroke: '#c7e6f4',
  text: '#00354e',
  muted: '#004b6f',
  accent: '#009EE3',
};

const iconNames = [
  'activity',
  'database',
  'file-check',
  'layout-dashboard',
  'list-checks',
  'message-circle',
  'server',
  'shield-check',
  'user-check',
  'wrench',
];

const icons = new Map(iconNames.map((name) => [name, readIcon(name)]));

function readIcon(name) {
  const raw = fs.readFileSync(path.join(iconDir, `${name}.svg`), 'utf8');
  const body = raw.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1];
  if (!body) {
    throw new Error(`Could not read Lucide icon body: ${name}`);
  }
  return body.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function num(value) {
  return Number(value.toFixed(3)).toString();
}

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n');
}

function icon(name, cx, y, size = 13) {
  const body = icons.get(name);
  if (!body) {
    throw new Error(`Unknown icon: ${name}`);
  }
  const scale = size / 24;
  return [
    `<g transform="translate(${num(cx - size / 2)} ${num(y)}) scale(${num(scale)})" fill="none" stroke="${colors.accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">`,
    indent(body, 6),
    '    </g>',
  ].join('\n');
}

function text(cx, y, value, options = {}) {
  const {
    size = 12,
    weight = undefined,
    fill = colors.muted,
    anchor = 'middle',
  } = options;
  const weightAttr = weight ? ` font-weight="${weight}"` : '';
  return `<text x="${num(cx)}" y="${num(y)}" text-anchor="${anchor}" font-size="${size}"${weightAttr} fill="${fill}">${esc(value)}</text>`;
}

function box({
  x,
  y,
  w,
  h,
  title,
  subtitle = [],
  iconName,
  accent = false,
  titleSize = 14,
  subtitleSize = 10.5,
}) {
  const cx = x + w / 2;
  const lines = Array.isArray(subtitle) ? subtitle : [subtitle].filter(Boolean);
  const titleY = y + 42;
  const subStart = lines.length > 1 ? y + 57 : y + 61;
  const subStep = lines.length > 1 ? 13 : 0;
  const fill = accent ? colors.bg : colors.white;
  const stroke = accent ? colors.accent : colors.stroke;

  return [
    `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="8" fill="${fill}" stroke="${stroke}"/>`,
    icon(iconName, cx, y + 8),
    text(cx, titleY, title, {
      size: titleSize,
      weight: '700',
      fill: colors.text,
    }),
    ...lines.map((line, index) =>
      text(cx, subStart + index * subStep, line, {
        size: subtitleSize,
        fill: colors.muted,
      }),
    ),
  ].join('\n');
}

function arrow(x1, y1, x2, y2) {
  const horizontal = Math.abs(y2 - y1) < 0.01;
  const vertical = Math.abs(x2 - x1) < 0.01;
  if (!horizontal && !vertical) {
    throw new Error('Only orthogonal arrows are supported');
  }

  let head;
  if (horizontal && x2 > x1) {
    head = `${num(x2)},${num(y2)} ${num(x2 - 13)},${num(y2 - 8)} ${num(x2 - 13)},${num(y2 + 8)}`;
  } else if (horizontal) {
    head = `${num(x2)},${num(y2)} ${num(x2 + 13)},${num(y2 - 8)} ${num(x2 + 13)},${num(y2 + 8)}`;
  } else if (y2 > y1) {
    head = `${num(x2)},${num(y2)} ${num(x2 - 8)},${num(y2 - 13)} ${num(x2 + 8)},${num(y2 - 13)}`;
  } else {
    head = `${num(x2)},${num(y2)} ${num(x2 - 8)},${num(y2 + 13)} ${num(x2 + 8)},${num(y2 + 13)}`;
  }

  return [
    `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"/>`,
    `<polygon points="${head}" fill="${colors.accent}" stroke="none"/>`,
  ].join('\n');
}

function polyArrow(points) {
  if (points.length < 2) {
    throw new Error('polyArrow needs at least two points');
  }
  const last = points.at(-1);
  const prev = points.at(-2);
  const d = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${num(x)} ${num(y)}`)
    .join(' ');

  let head;
  if (last[0] > prev[0]) {
    head = `${num(last[0])},${num(last[1])} ${num(last[0] - 13)},${num(last[1] - 8)} ${num(last[0] - 13)},${num(last[1] + 8)}`;
  } else if (last[0] < prev[0]) {
    head = `${num(last[0])},${num(last[1])} ${num(last[0] + 13)},${num(last[1] - 8)} ${num(last[0] + 13)},${num(last[1] + 8)}`;
  } else if (last[1] > prev[1]) {
    head = `${num(last[0])},${num(last[1])} ${num(last[0] - 8)},${num(last[1] - 13)} ${num(last[0] + 8)},${num(last[1] - 13)}`;
  } else {
    head = `${num(last[0])},${num(last[1])} ${num(last[0] - 8)},${num(last[1] + 13)} ${num(last[0] + 8)},${num(last[1] + 13)}`;
  }

  return [
    `<path d="${d}"/>`,
    `<polygon points="${head}" fill="${colors.accent}" stroke="none"/>`,
  ].join('\n');
}

function svg({ title, desc, body }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by talks/render-diagrams.mjs. Icons: lucide-static, see assets/icons/LUCIDE-LICENSE. -->
<svg xmlns="http://www.w3.org/2000/svg" width="860" height="300" viewBox="0 0 860 300" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(desc)}</desc>
  <rect x="0" y="0" width="860" height="300" rx="12" fill="${colors.bg}"/>
  <g font-family="Open Sans, Arial, sans-serif">
${indent(body.trim(), 4)}
  </g>
</svg>
`;
}

function renderToolFlow() {
  const boxW = 152;
  const boxH = 70;
  const xs = [36, 222, 408, 594];
  const topY = 48;
  const bottomY = 180;
  const midTop = topY + boxH / 2;
  const midBottom = bottomY + boxH / 2;

  const arrows = [
    arrow(xs[0] + boxW, midTop, xs[1], midTop),
    arrow(xs[1] + boxW, midTop, xs[2], midTop),
    arrow(xs[2] + boxW, midTop, xs[3], midTop),
    arrow(xs[3] + boxW / 2, topY + boxH, xs[3] + boxW / 2, bottomY),
    arrow(xs[3], midBottom, xs[2] + boxW, midBottom),
    arrow(xs[2], midBottom, xs[1] + boxW, midBottom),
  ].join('\n');

  const boxes = [
    box({ x: xs[0], y: topY, w: boxW, h: boxH, title: 'Agent', subtitle: 'stellt Abfrage', iconName: 'message-circle' }),
    box({ x: xs[1], y: topY, w: boxW, h: boxH, title: 'Tool-Schema', subtitle: 'UID, Query, Zeit', iconName: 'wrench' }),
    box({ x: xs[2], y: topY, w: boxW, h: boxH, title: 'Allow-List', subtitle: 'Datasource erlaubt?', iconName: 'shield-check', accent: true }),
    box({ x: xs[3], y: topY, w: boxW, h: boxH, title: 'Grafana Query API', subtitle: 'als aktueller User', iconName: 'server', titleSize: 13 }),
    box({ x: xs[3], y: bottomY, w: boxW, h: boxH, title: 'Prometheus', subtitle: 'Instant oder Range', iconName: 'database' }),
    box({ x: xs[2], y: bottomY, w: boxW, h: boxH, title: 'Summary', subtitle: 'min, max, last', iconName: 'list-checks' }),
    box({ x: xs[1], y: bottomY, w: boxW, h: boxH, title: 'Zurück zum Modell', subtitle: 'Evidenz statt Rohdaten', iconName: 'activity', titleSize: 13 }),
    box({
      x: xs[0],
      y: bottomY,
      w: boxW,
      h: boxH,
      title: 'Tool-Renderer',
      subtitle: 'Grafana-Control',
      iconName: 'activity',
      titleSize: 13,
      subtitleSize: 10,
    }),
  ].join('\n\n');

  return svg({
    title: 'query_prometheus Toolfluss',
    desc: 'Das Tool validiert Argumente, fragt Daten über Grafana ab, rendert passende Controls und gibt eine kompakte Zusammenfassung zurück.',
    body: `
<g fill="none" stroke="${colors.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
${indent(arrows, 2)}
</g>

${boxes}`,
  });
}

function renderJsonnetLoop() {
  const boxW = 140;
  const boxH = 70;
  const xs = [38, 203, 368, 533, 698];
  const topY = 44;
  const repairY = 178;
  const midTop = topY + boxH / 2;
  const midRepair = repairY + boxH / 2;

  const arrows = [
    arrow(xs[0] + boxW, midTop, xs[1], midTop),
    arrow(xs[1] + boxW, midTop, xs[2], midTop),
    arrow(xs[2] + boxW, midTop, xs[3], midTop),
    arrow(xs[3] + boxW, midTop, xs[4], midTop),
    arrow(xs[2] + boxW / 2, topY + boxH, xs[2] + boxW / 2, repairY),
    polyArrow([
      [xs[2], midRepair],
      [xs[1] + boxW / 2, midRepair],
      [xs[1] + boxW / 2, topY + boxH],
    ]),
  ].join('\n');

  const boxes = [
    box({ x: xs[0], y: topY, w: boxW, h: boxH, title: 'read_jsonnet', subtitle: 'Quelle lesen', iconName: 'file-check', titleSize: 13 }),
    box({ x: xs[1], y: topY, w: boxW, h: boxH, title: 'edit_jsonnet', subtitle: 'gezielte Änderung', iconName: 'wrench', titleSize: 13 }),
    box({ x: xs[2], y: topY, w: boxW, h: boxH, title: 'render_dashboard', subtitle: 'compile', iconName: 'server', accent: true, titleSize: 12.5 }),
    box({ x: xs[3], y: topY, w: boxW, h: boxH, title: 'Preview JSON', subtitle: 'Dashboard', iconName: 'layout-dashboard', titleSize: 13 }),
    box({ x: xs[4], y: topY, w: boxW, h: boxH, title: 'sync_dashboard', subtitle: 'speichern', iconName: 'database', titleSize: 12.5 }),
    box({ x: xs[2], y: repairY, w: boxW, h: boxH, title: 'fix_jsonnet', subtitle: 'bei Fehlern', iconName: 'shield-check', titleSize: 13 }),
  ].join('\n\n');

  return svg({
    title: 'Jsonnet Dashboard Loop',
    desc: 'Jsonnet wird gelesen, editiert, kompiliert, validiert und nach erfolgreichem Preview synchronisiert.',
    body: `
<g fill="none" stroke="${colors.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
${indent(arrows, 2)}
</g>

${boxes}`,
  });
}

function renderGuardrails() {
  const boxW = 238;
  const boxH = 72;
  const leftX = 40;
  const centerX = 311;
  const rightX = 582;
  const topY = 24;
  const midY = 112;
  const bottomY = 200;
  const center = centerX + boxW / 2;
  const mid = midY + boxH / 2;

  const arrows = [
    arrow(leftX + boxW, mid, centerX, mid),
    arrow(rightX, mid, centerX + boxW, mid),
    arrow(center, topY + boxH, center, midY),
    arrow(center, bottomY, center, midY + boxH),
  ].join('\n');

  const boxes = [
    box({
      x: centerX,
      y: midY,
      w: boxW,
      h: boxH,
      title: 'Agent Runtime',
      subtitle: 'plant und ruft Tools auf',
      iconName: 'activity',
      accent: true,
      titleSize: 16,
    }),
    box({
      x: leftX,
      y: midY,
      w: boxW,
      h: boxH,
      title: 'Datenraum',
      subtitle: 'freigegebene Datenquellen',
      iconName: 'database',
      titleSize: 16,
    }),
    box({
      x: centerX,
      y: topY,
      w: boxW,
      h: boxH,
      title: 'Tool-Auswahl',
      subtitle: 'pro Anfrage begrenzt',
      iconName: 'list-checks',
      titleSize: 16,
    }),
    box({
      x: rightX,
      y: midY,
      w: boxW,
      h: boxH,
      title: 'Freigabe',
      subtitle: 'Schreibaktionen nur nach Approval',
      iconName: 'user-check',
      titleSize: 16,
    }),
    box({
      x: centerX,
      y: bottomY,
      w: boxW,
      h: boxH,
      title: 'Nachvollziehbarkeit',
      subtitle: 'Tags, Jsonnet, Checksum',
      iconName: 'file-check',
      titleSize: 15,
    }),
  ].join('\n\n');

  return svg({
    title: 'Kontrolle und Guardrails',
    desc: 'Datenraum, Tool-Auswahl, Freigabe und Nachvollziehbarkeit begrenzen den Agenten.',
    body: `
<g fill="none" stroke="${colors.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
${indent(arrows, 2)}
</g>

${boxes}`,
  });
}

fs.writeFileSync(path.join(assetDir, 'prometheus-tool.svg'), renderToolFlow());
fs.writeFileSync(path.join(assetDir, 'jsonnet-loop.svg'), renderJsonnetLoop());
fs.writeFileSync(path.join(assetDir, 'guardrails.svg'), renderGuardrails());
