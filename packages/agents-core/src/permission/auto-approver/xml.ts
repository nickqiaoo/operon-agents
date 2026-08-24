// XML response parsing for the two-stage classifier.
// The classifier emits `<block>yes|no</block>` plus an optional `<reason>`; stage 2 may also
// emit `<thinking>`. Thinking content is stripped first so tags inside the model's reasoning
// aren't mistaken for the verdict.

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").replace(/<thinking>[\s\S]*$/, "");
}

/** `true` = should block, `false` = allow, `null` = unparseable (caller fails closed). */
export function parseXmlBlock(text: string): boolean | null {
  const matches = [...stripThinking(text).matchAll(/<block>(yes|no)\b(<\/block>)?/gi)];
  if (matches.length === 0) return null;
  return matches[0]![1]!.toLowerCase() === "yes";
}

export function parseXmlReason(text: string): string | null {
  const matches = [...stripThinking(text).matchAll(/<reason>([\s\S]*?)<\/reason>/g)];
  if (matches.length === 0) return null;
  return matches[0]![1]!.trim();
}

export function parseXmlThinking(text: string): string | null {
  const match = /<thinking>([\s\S]*?)<\/thinking>/.exec(text);
  return match ? match[1]!.trim() : null;
}
