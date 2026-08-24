export interface SseFrame<T = unknown> {
  readonly event: string;
  readonly id?: string;
  readonly data: T;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const decoded = decodeSseFrame(frame);
        if (decoded !== undefined) yield decoded;
      }
    }
    buffer += decoder.decode();
    const decoded = decodeSseFrame(buffer);
    if (decoded !== undefined) yield decoded;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function decodeSseFrame(frame: string): SseFrame | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  const raw = data.join("\n");
  return {
    event,
    ...(id !== undefined ? { id } : {}),
    data: JSON.parse(raw) as unknown,
  };
}
