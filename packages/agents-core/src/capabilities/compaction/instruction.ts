export function compactionInstruction(customInstruction = ""): string {
  const base = `Your context is being compacted. Summarize the conversation ABOVE into a single, self-contained briefing so work can continue from it without losing essential state. Be concrete and faithful; do not invent. Write the briefing in the same language the conversation has been using — do not switch to English just because these instructions are in English. Use these sections (omit a section only if truly empty):

## Current Focus & Forward Plan
The task in progress right now, then the plan the next turn will follow — and this is the moment to invest in it. Right now you hold more context on this task than you ever will again; the next turn resumes with less, so the plan you commit here is the one it will follow. Give the exact next command or tool call, but don't stop at the next step: set out the remaining sequence to finish, the decisions you have already made for those upcoming steps (so the next turn doesn't reopen them), the obstacles or edge cases you can already foresee and how you mean to handle them, and any work you can commit to now — the exact patch, query, or shape of the final answer you already know you will produce. Include any required format for the final answer.

## Environment
Working directory, key paths, tools/commands, versions, and config that matter.

## Completed Tasks
What has already been done, at high fidelity: the exact commands run, the exact file paths touched, and whether each succeeded or failed — with the concrete results themselves (values returned, key lines or error text, the schema or signature a lookup revealed), not just the commands, since re-running to recover them may be slow or impossible. Keep only the final working version of any code; drop intermediate attempts and already-resolved errors.

## Active Issues
Open problems, errors seen, and anything still failing or unverified. Be honest about uncertainty: if an earlier step claimed something was done but was never verified (tests "passing", a fix "working", a file "created"), say so plainly and treat it as unverified rather than fact.

## Unknowns
Context the next step depends on that this conversation never established — files or paths referenced but not yet read, schemas or APIs assumed but unseen, questions the user has not answered. Name these gaps so the next turn goes and checks them instead of assuming.

## Code State
Files created/modified and their current state — for each critical file, its path and what it now contains or how it changed.

## Important Context
Decisions made and their rationale, constraints, user preferences, and anything non-obvious needed to continue.

## All User Messages
A faithful list of every distinct request/instruction the user gave, in order, so no user intent is lost.

Output ONLY the summary in the sections above. Do not call any tools.`;

  return customInstruction.trim().length > 0 ? `${base}\n\nAdditional instruction: ${customInstruction.trim()}` : base;
}
