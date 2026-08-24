import type { ToolResultContent } from "../index.ts";
import type { MCPContentBlock, MCPToolResult } from "./types.ts";

export const MCP_MAX_OUTPUT_CHARS = 100_000;
const MCP_OUTPUT_TRUNCATED_TEXT = `\n\n[Output truncated: exceeded ${MCP_MAX_OUTPUT_CHARS} character limit. Use pagination or more specific queries to get remaining content.]`;

export const MCP_MAX_IMAGE_PART_BYTES = 10 * 1024 * 1024;
const MCP_MAX_IMAGE_PART_CHARS = Math.ceil((MCP_MAX_IMAGE_PART_BYTES * 4) / 3);

type Part = ToolResultContent[number];

function imageTooLargeNotice(urlLength: number): Part {
  const approxMb = ((urlLength * 3) / 4 / (1024 * 1024)).toFixed(1);
  const capMb = String(MCP_MAX_IMAGE_PART_BYTES / (1024 * 1024));
  return { type: "text", text: `[image dropped: ~${approxMb} MB exceeds ${capMb} MB per-part limit. Try a smaller resource.]` };
}

function mediaNote(kind: string): Part {
  return { type: "text", text: `[${kind} content omitted: not representable in this tool-result content model.]` };
}

export function convertMcpContentBlock(block: MCPContentBlock): Part | null {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image" && typeof block.data === "string") {
    return { type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" };
  }
  if (block.type === "audio") return mediaNote("audio");

  // EmbeddedResource: payload nested under `resource` (text or blob).
  if (block.type === "resource" && block.resource) {
    const res = block.resource;
    if (typeof res.text === "string") return { type: "text", text: res.text };
    if (typeof res.blob === "string") {
      const mimeType = res.mimeType ?? "application/octet-stream";
      if (mimeType.startsWith("image/")) return { type: "image", data: res.blob, mimeType };
      if (mimeType.startsWith("audio/")) return mediaNote("audio");
      if (mimeType.startsWith("video/")) return mediaNote("video");
      return null;
    }
    return null;
  }

  // ResourceLink: a URL reference (our ImageContent needs inline base64, not a URL).
  if (block.type === "resource_link" && typeof block.uri === "string") {
    return { type: "text", text: `[resource: ${block.uri}${block.mimeType ? ` (${block.mimeType})` : ""}]` };
  }
  return null;
}

export function mcpResultToContent(result: MCPToolResult, qualifiedToolName: string): { content: ToolResultContent; isError: boolean } {
  const converted: Part[] = [];
  for (const block of result.content) {
    const part = convertMcpContentBlock(block);
    if (part !== null) converted.push(part);
  }
  const wrapped = wrapMediaOnly(converted, qualifiedToolName);
  const limited = applyOutputLimits(wrapped);
  const content = limited.length > 0 ? limited : [{ type: "text", text: "" } as Part];
  return { content, isError: result.isError === true };
}

function wrapMediaOnly(parts: readonly Part[], qualifiedToolName: string): Part[] {
  const hasMedia = parts.some((p) => p.type === "image");
  const hasNonEmptyText = parts.some((p) => p.type === "text" && p.text.length > 0);
  if (!hasMedia || hasNonEmptyText) return [...parts];
  return [
    { type: "text", text: `<mcp_tool_result name="${qualifiedToolName}">` },
    ...parts,
    { type: "text", text: "</mcp_tool_result>" },
  ];
}

function applyOutputLimits(parts: readonly Part[]): Part[] {
  let remaining = MCP_MAX_OUTPUT_CHARS;
  let textTruncated = false;
  const out: Part[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (remaining <= 0) {
        textTruncated = true;
        continue;
      }
      if (part.text.length > remaining) {
        out.push({ type: "text", text: part.text.slice(0, remaining) });
        remaining = 0;
        textTruncated = true;
      } else {
        out.push(part);
        remaining -= part.text.length;
      }
      continue;
    }
    // image: per-part byte cap, independent of the text budget.
    if (part.data.length > MCP_MAX_IMAGE_PART_CHARS) {
      out.push(imageTooLargeNotice(part.data.length));
      continue;
    }
    out.push(part);
  }

  if (textTruncated) appendTruncationNotice(out);
  return out;
}

function appendTruncationNotice(out: Part[]): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const candidate = out[i];
    if (candidate?.type === "text") {
      out[i] = { type: "text", text: candidate.text + MCP_OUTPUT_TRUNCATED_TEXT };
      return;
    }
  }
  out.push({ type: "text", text: MCP_OUTPUT_TRUNCATED_TEXT });
}
