import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildExportMarkdown } from '../utils/export-markdown.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import { MAIN_AGENT_ID } from '../constant/tui.ts';
import type { SlashCommandHost } from './dispatch.ts';

const INIT_PROMPT = [
  'Analyze this codebase and write an AGENTS.md at its root for future agent sessions.',
  '',
  'Cover: what the project is, how it is laid out, how to build / test / run it, the conventions a',
  'contributor must follow, and anything surprising that would trip someone up. Read enough of the',
  'code to be accurate, prefer what the repository actually does over what its docs claim, and keep',
  'it short enough to stay read.',
  '',
  'If an AGENTS.md already exists, improve it in place instead of replacing it wholesale.',
].join('\n');

/** `/init` — have the agent write (or improve) this repository's AGENTS.md. */
export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  host.sendQueuedMessage(session, { text: INIT_PROMPT });
}

/** `/title [text]` — show or set the session title (it names the terminal tab too). */
export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(current === null || current.length === 0 ? 'This session has no title.' : `Title: ${current}`, 'textMuted');
    return;
  }
  try {
    await host.harness.renameSession(session.id, title);
  } catch (error) {
    host.showError(`Failed to set the title: ${formatErrorMessage(error)}`);
    return;
  }
  host.setAppState({ sessionTitle: title });
  host.showStatus(`Title: ${title}`, 'success');
}

/** `/fork [title]` — copy the session (log and state) without switching to the copy. */
export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  const title = args.trim();
  try {
    const forked = await host.harness.forkSession(session.id, title.length > 0 ? { title } : {});
    const id = forked.id;
    // The fork is a separate open session; close it so only the current one stays live.
    await host.harness.closeSession(id);
    host.showStatus(`Forked into ${id}. Open it with /resume ${id}.`, 'success');
  } catch (error) {
    host.showError(`Failed to fork the session: ${formatErrorMessage(error)}`);
  }
}

/** `/export-md [path]` — write the conversation to a Markdown file. */
export async function handleExportMdCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  const target = resolve(host.state.appState.workDir, args.trim().length > 0 ? args.trim() : `operon-session-${session.id}.md`);
  try {
    const records = await session.getRecords(MAIN_AGENT_ID);
    const markdown = buildExportMarkdown({
      sessionId: session.id,
      title: host.state.appState.sessionTitle,
      workDir: host.state.appState.workDir,
      model: host.state.appState.model,
      records,
    });
    await writeFile(target, markdown, 'utf-8');
    host.showStatus(`Exported to ${target}`, 'success');
  } catch (error) {
    host.showError(`Failed to export: ${formatErrorMessage(error)}`);
  }
}
