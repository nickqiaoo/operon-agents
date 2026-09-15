import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContextBreakdown } from 'operon-agents';

import { BoxPanelComponent } from '../src/components/messages/box-panel.ts';
import { buildContextReportLines, ContextPanelComponent } from '../src/components/messages/context-panel.ts';
import { buildMcpStatusLines, McpStatusPanelComponent } from '../src/components/messages/mcp-status-panel.ts';
import { buildStatusReportLines, StatusPanelComponent } from '../src/components/messages/status-panel.ts';
import { buildUsageReportLines, UsagePanelComponent } from '../src/components/messages/usage-panel.ts';
import { buildPluginsSummaryLines } from '../src/components/messages/plugins-status-panel.ts';
import { formatTokenCount, ratioSeverity, renderProgressBar, safeUsageRatio, usagePercent } from '../src/app/utils/usage/usage-format.ts';
import { imagePlaceholder, extractMediaAttachments, referencedAttachmentIds } from '../src/utils/image-placeholder.ts';
import { ImageAttachmentStore } from '../src/utils/image-attachment-store.ts';
import { currentTheme, getBuiltInPalette } from '../src/theme/index.ts';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[\\d;]*m', 'g');

/** Every render assertion measures the plain text, not the ANSI a palette adds. */
function strip(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(ANSI, ''));
}

test('token counts read as humans write them', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1500), '1.5k');
  assert.equal(formatTokenCount(25_000), '25k');
  assert.equal(formatTokenCount(2_400_000), '2.4M');
});

test('a fill ratio is clamped, shown as a percentage, and colored by severity', () => {
  assert.equal(safeUsageRatio(0.5), 0.5);
  assert.equal(safeUsageRatio(2), 1);
  assert.equal(safeUsageRatio(-1), 0);
  // With no ratio the counts stand in for it.
  assert.equal(safeUsageRatio(0, 50, 200), 0.25);
  assert.equal(usagePercent(0.256), '26%');
  assert.equal(ratioSeverity(0.1), 'success');
  assert.equal(ratioSeverity(0.75), 'warning');
  assert.equal(ratioSeverity(0.95), 'error');
});

test('a progress bar fills proportionally and keeps its width', () => {
  const bar = strip([renderProgressBar(0.5, 10)])[0]!;
  assert.equal(bar.length, 10);
  assert.equal(bar.slice(0, 5), '█████');
  assert.equal(strip([renderProgressBar(0, 4)])[0], '░░░░');
  assert.equal(strip([renderProgressBar(1, 4)])[0], '████');
});

test('a box panel frames its body and stays inside the width', () => {
  const panel = new BoxPanelComponent(() => ['first', 'second'], 'primary', ' Title ');
  const lines = strip(panel.render(40));
  assert.match(lines[0] ?? '', /^ {2}╭ Title ─+╮$/);
  assert.match(lines[1] ?? '', /^ {2}│ first {2,}│$/);
  assert.match(lines.at(-1) ?? '', /^ {2}╰─+╯$/);
  for (const line of lines) assert.ok(line.length <= 40, `line wider than the terminal: ${line}`);
});

test('a box panel degrades to bare lines when the terminal is too narrow to frame', () => {
  const panel = new BoxPanelComponent(() => ['body'], 'primary', ' T ');
  // Truncation keeps an ellipsis so the reader knows the line was cut.
  assert.deepEqual(strip(panel.render(3)), ['T', 'bo…']);
});

test('/status reports the runtime knobs a turn depends on', () => {
  const lines = strip(
    buildStatusReportLines({
      version: '1.2.3',
      model: 'Claude Opus 4.8',
      thinking: 'High',
      permission: 'Always Ask',
      planMode: true,
      workDir: '/repo',
      sessionId: 's1',
      sessionTitle: 'Refactor',
      mcpServers: 2,
      skills: 7,
      plugins: 1,
    }),
  ).join('\n');
  for (const expected of ['1.2.3', 'Claude Opus 4.8', 'High', 'Always Ask', '/repo', 's1', 'Refactor']) {
    assert.ok(lines.includes(expected), `missing ${expected}`);
  }
  assert.match(lines, /Plan mode\s+on/);
  assert.match(lines, /MCP servers\s+2/);
});

test('/status says so plainly when no session exists yet', () => {
  const lines = strip(
    buildStatusReportLines({
      version: '1',
      model: '',
      thinking: 'Medium',
      permission: 'Always Ask',
      planMode: false,
      workDir: '/repo',
      sessionId: '',
      sessionTitle: null,
      mcpServers: 0,
      skills: 0,
      plugins: 0,
    }),
  ).join('\n');
  assert.match(lines, /\(not created yet\)/);
  assert.match(lines, /Model\s+\(none\)/);
  assert.ok(!lines.includes('Title'), 'a session with no title should not get a Title row');
});

test('/mcp shows one row per server with its state and tool count', () => {
  const lines = strip(
    buildMcpStatusLines([
      { name: 'github', transport: 'http', status: 'connected', toolCount: 12 },
      { name: 'broken', transport: 'stdio', status: 'failed', toolCount: 0, error: 'spawn ENOENT' },
      { name: 'waiting', transport: 'stdio', status: 'pending', toolCount: 0 },
    ]),
  ).join('\n');
  assert.match(lines, /github\s+connected \(http\) · 12 tools/);
  assert.match(lines, /broken\s+failed \(stdio\)/);
  assert.match(lines, /spawn ENOENT/);
  assert.match(lines, /waiting\s+connecting/);
  // A tool count is only shown for a server that is actually connected.
  assert.ok(!/waiting.*tool/.test(lines));
});

test('/usage reports session tokens and the context gauge', () => {
  const lines = strip(
    buildUsageReportLines({ model: 'Claude', cumulativeTokens: 25_000, contextTokens: 40_000, maxContextTokens: 200_000, contextUsage: 0.2 }, 60),
  ).join('\n');
  assert.match(lines, /Model\s+Claude/);
  assert.match(lines, /Session\s+25k tokens/);
  assert.match(lines, /Context\s+40k \/ 200k 20%/);
});

test('/usage says the context is unmeasured rather than showing a zero gauge', () => {
  const lines = strip(
    buildUsageReportLines({ model: 'Claude', cumulativeTokens: 0, contextTokens: 0, maxContextTokens: 0, contextUsage: 0 }, 60),
  ).join('\n');
  assert.match(lines, /measured at the first turn boundary/);
});

const BREAKDOWN: ContextBreakdown = {
  contextWindow: 200_000,
  model: 'anthropic/claude-opus-4-8',
  used: 50_000,
  usedPercent: 25,
  systemPrompt: { tokens: 2_000, percent: 1 },
  toolsBuiltin: { tokens: 8_000, percent: 4 },
  toolsMcp: { tokens: 0, percent: 0 },
  messages: { tokens: 38_000, percent: 19 },
  injections: [
    { id: 'skill_catalog', tokens: 1_500, percent: 0.75 },
    { id: 'todo', tokens: 500, percent: 0.25 },
  ],
  compactBuffer: { tokens: 20_000, percent: 10 },
  free: { tokens: 130_000, percent: 65 },
  capturedAt: 1,
};

test('/context breaks the window into its slices and drops the empty ones', () => {
  const lines = strip(buildContextReportLines(BREAKDOWN, 80)).join('\n');
  assert.match(lines, /Model\s+anthropic\/claude-opus-4-8/);
  assert.match(lines, /Used\s+50k \/ 200k 25%/);
  assert.match(lines, /System prompt\s+2\.0k/);
  assert.match(lines, /Injection: skill_catalog\s+1\.5k/);
  assert.match(lines, /Compaction reserve\s+20k/);
  assert.match(lines, /Free\s+130k/);
  assert.ok(!lines.includes('Tools (MCP)'), 'a zero-token slice should not be listed');
});

test('the report panels render inside any terminal width', () => {
  const panels = [
    new StatusPanelComponent({
      version: '1',
      model: 'Claude',
      thinking: 'Medium',
      permission: 'Always Ask',
      planMode: false,
      workDir: '/repo',
      sessionId: 's1',
      sessionTitle: null,
      mcpServers: 0,
      skills: 0,
      plugins: 0,
    }),
    new McpStatusPanelComponent([{ name: 'x', transport: 'stdio', status: 'connected', toolCount: 1 }]),
    new UsagePanelComponent({ model: 'Claude', cumulativeTokens: 1, contextTokens: 1, maxContextTokens: 10, contextUsage: 0.1 }),
    new ContextPanelComponent(BREAKDOWN),
  ];
  for (const panel of panels) {
    for (const width of [20, 40, 80, 200]) {
      for (const line of strip(panel.render(width))) {
        assert.ok(line.length <= width, `${panel.constructor.name} overflowed at width ${String(width)}: ${line}`);
      }
    }
    // A theme switch has to repaint the cached body.
    panel.invalidate();
  }
});

test('invalidate re-runs the body builder, so a theme switch repaints cached colors', () => {
  let built = 0;
  const panel = new BoxPanelComponent(() => {
    built += 1;
    return [currentTheme.fg('success', `build ${String(built)}`)];
  }, 'primary', ' T ');
  assert.equal(built, 1);
  assert.match(strip(panel.render(20)).join('\n'), /build 1/);

  currentTheme.setPalette(getBuiltInPalette('light'));
  panel.invalidate();
  currentTheme.setPalette(getBuiltInPalette('dark'));
  assert.equal(built, 2);
  assert.match(strip(panel.render(20)).join('\n'), /build 2/);
});

test('the plugin summary lists each plugin with its counts and source', () => {
  const lines = strip(
    buildPluginsSummaryLines([
      {
        id: 'acme',
        displayName: 'Acme',
        version: '1.0.0',
        enabled: true,
        state: 'ok',
        skillCount: 3,
        mcpServerCount: 2,
        enabledMcpServerCount: 1,
        hasErrors: false,
        source: 'github',
        github: { owner: 'acme', repo: 'plugin', ref: { kind: 'branch', value: 'main' } },
      },
    ]),
  ).join('\n');
  assert.match(lines, /Acme/);
  assert.match(lines, /3 skills · 1\/2 MCP/);
  assert.match(lines, /github acme\/plugin@main/);
});

test('a pasted image round-trips through its placeholder into an image part', () => {
  const store = new ImageAttachmentStore();
  const attachment = store.add({ data: 'QUJD', mimeType: 'image/png', width: 640, height: 480, bytes: 3 });
  const placeholder = imagePlaceholder(attachment.id, attachment.width, attachment.height);
  assert.equal(placeholder, '[image #1 (640×480)]');

  const extraction = extractMediaAttachments(`look at ${placeholder} please`, store);
  assert.equal(extraction.hasMedia, true);
  assert.deepEqual(extraction.imageAttachmentIds, [1]);
  assert.deepEqual(extraction.parts, [
    { type: 'text', text: 'look at ' },
    { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    { type: 'text', text: ' please' },
  ]);
  assert.deepEqual(referencedAttachmentIds(`a ${placeholder} b`), [1]);
});

test('text with no image stays one text part, and a dropped attachment stays literal text', () => {
  const store = new ImageAttachmentStore();
  const plain = extractMediaAttachments('just text', store);
  assert.equal(plain.hasMedia, false);
  assert.deepEqual(plain.parts, [{ type: 'text', text: 'just text' }]);

  // The attachment its message referenced has left the transcript window.
  const stale = extractMediaAttachments('gone [image #42 (1×1)]', store);
  assert.equal(stale.hasMedia, false);
  assert.deepEqual(stale.parts, [{ type: 'text', text: 'gone [image #42 (1×1)]' }]);
});

test('the attachment store tracks its byte total and releases what it is told to', () => {
  const store = new ImageAttachmentStore();
  const first = store.add({ data: 'QQ==', mimeType: 'image/png', bytes: 100 });
  const second = store.add({ data: 'Qg==', mimeType: 'image/png', bytes: 250 });
  assert.equal(store.totalBytes(), 350);
  assert.notEqual(first.id, second.id);
  store.removeMany([first.id]);
  assert.equal(store.get(first.id), undefined);
  assert.equal(store.totalBytes(), 250);
  store.clear();
  assert.equal(store.totalBytes(), 0);
});
