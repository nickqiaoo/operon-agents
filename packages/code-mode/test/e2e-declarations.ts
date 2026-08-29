/**
 * The generated `declare const tools` API: JSON Schema → TypeScript, the shape the model
 * programs against. Real builtin schemas plus hand-built corners (refs, cycles, enums, names
 * that are not identifiers).
 */
import { readTool, grepTool } from "operon-agents-core";
import type { ToolSchema } from "operon-agents-core";
import { briefOf, renderToolDeclarations } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function schema(name: string, description: string, parameters: Record<string, unknown>): ToolSchema {
  return { name, description, parameters };
}

function main(): void {
  const builtin = renderToolDeclarations([grepTool.schema, readTool.schema]);
  console.log(builtin);
  check("builtin: Read renders its real parameters", builtin.includes("Read(args: { path: string; line_offset?: number; n_lines?: number }): Promise<string>;"));
  check("builtin: an anyOf of two integer ranges collapses to one number", !builtin.includes("number | number"));
  check("builtin: tools are sorted by name", builtin.indexOf("Grep(") < builtin.indexOf("Read("));
  check("builtin: brief keeps the first paragraph as a one-line JSDoc", /\/\*\* Reads? [^\n]*\*\/\n  Read\(/.test(builtin));

  const corners = renderToolDeclarations([
    schema("mcp__github__list-issues", "List issues.\n\nSecond paragraph.", {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed"] },
        limit: { type: "integer", default: 10 },
        labels: { type: "array", items: { type: "string" } },
        filter: { $ref: "#/$defs/Filter" },
        page: { anyOf: [{ type: "number" }, { type: "null" }] },
        tags: { type: ["string", "array"], items: { type: "string" } },
        mode: { const: "fast" },
      },
      required: ["state"],
      $defs: {
        Filter: {
          type: "object",
          properties: { author: { type: "string" }, nested: { $ref: "#/$defs/Filter" } },
        },
      },
    }),
    schema("Nothing", "Takes nothing.", { type: "object", properties: {}, additionalProperties: false }),
    schema("Anything", "Takes anything.", { type: "object" }),
    schema("Mapish", "A map.", { type: "object", additionalProperties: { type: "number" } }),
    schema("Tuple", "A tuple.", { type: "object", properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] } }, required: ["pair"] }),
    schema("Weird*/Name", "Ends a comment */ here.", { type: "object", properties: { "not-an-identifier": { type: "boolean" } } }),
  ]);
  console.log(corners);
  check("corner: a name that is not an identifier is a quoted key, never aliased", corners.includes('"mcp__github__list-issues"(args: {'));
  check("corner: enum → string literal union", corners.includes('state: "open" | "closed"'));
  check("corner: const → literal", corners.includes('mode?: "fast"'));
  check("corner: array items", corners.includes("labels?: string[]"));
  check("corner: local $ref is followed; the cycle inside it degrades to unknown", corners.includes("filter?: { author?: string; nested?: unknown }"));
  check("corner: anyOf → union", corners.includes("page?: number | null"));
  check("corner: a type array → union", corners.includes("tags?: string | string[]"));
  check("corner: brief takes the first paragraph only", corners.includes("/** List issues. */") && !corners.includes("Second paragraph"));
  check("corner: no parameters → optional empty object", corners.includes("Nothing(args?: {}): Promise<string>;"));
  check("corner: an untyped object → optional Record", corners.includes("Anything(args?: Record<string, unknown>): Promise<string>;"));
  check("corner: additionalProperties schema → Record of it", corners.includes("Mapish(args?: Record<string, number>): Promise<string>;"));
  check("corner: prefixItems → tuple", corners.includes("pair: [string, number]"));
  check("corner: a comment closer in a description cannot end the JSDoc", corners.includes("Ends a comment *\\/ here.") && !corners.includes("comment */ here"));
  check("corner: a property that is not an identifier is quoted", corners.includes('"not-an-identifier"?: boolean'));

  const full = renderToolDeclarations([
    schema("Documented", "First.\n\nSecond paragraph.", {
      type: "object",
      properties: { path: { type: "string", description: "Where to look" } },
      required: ["path"],
    }),
  ], { descriptions: "full" });
  check("full: keeps every paragraph of the tool description", full.includes("First.") && full.includes("Second paragraph."));
  check("full: carries parameter descriptions inline", full.includes("{ /** Where to look */ path: string }"));
  check("returnType is configurable", renderToolDeclarations([schema("X", "x", { type: "object" })], { returnType: "Promise<unknown>" }).includes("Promise<unknown>"));

  check("briefOf caps a long first paragraph", briefOf(`${"word ".repeat(100)}\n\nmore`).length <= 240);
  check("briefOf collapses whitespace", briefOf("a\n  b   c") === "a b c");

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ DECLARATIONS E2E PASS");
}

main();
