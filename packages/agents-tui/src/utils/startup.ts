/** Join startup notices into the single status line the TUI prints once the first frame is up. */
export function combineStartupNotice(existing: string | undefined, extra: string): string {
  if (existing === undefined || existing.length === 0) return extra;
  return `${existing}\n${extra}`;
}
