/**
 * Workflow script parsing & validation.
 *
 * Rules enforced:
 *  - Script must be plain JS (acorn parse; TS syntax fails).
 *  - First statement must be `export const meta = {<pure literal>}`.
 *  - `meta` must be a pure literal (no variables, calls, spreads, template
 *    interpolation, computed keys, methods/accessors).
 *  - `name` + `description` required non-empty strings; `phases` optional.
 *  - Script size capped at WORKFLOW_SCRIPT_MAX_BYTES.
 */

import { parse } from "acorn";
import {
  WORKFLOW_SCRIPT_MAX_BYTES,
  type ParsedWorkflow,
  type WorkflowMeta,
  type WorkflowPhaseMeta,
} from "./types.ts";

/** Minimal structural view of an acorn AST node. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const RESERVED_META_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type ParseResult = ParsedWorkflow | { error: string };

export function parseWorkflow(script: string): ParseResult {
  if (script.length > WORKFLOW_SCRIPT_MAX_BYTES) {
    return { error: `Script exceeds ${WORKFLOW_SCRIPT_MAX_BYTES} bytes` };
  }

  let program: AstNode;
  try {
    program = parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error:
        `Script parse error: ${msg}. Workflow scripts must be plain JavaScript — ` +
        "TypeScript syntax (type annotations like `: string[]`, interfaces, generics) fails to parse.",
    };
  }

  const body = (program.body as AstNode[]) ?? [];
  const first = body[0];
  if (!first || !isMetaExport(first)) {
    return { error: "`export const meta = { name, description, phases }` must be the FIRST statement in the script" };
  }

  const declaration = first.declaration as AstNode;
  const declarator = (declaration.declarations as AstNode[])[0]!;
  const init = declarator.init as AstNode;

  let literal: unknown;
  try {
    literal = evalLiteral(init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `meta must be a pure literal: ${msg}` };
  }

  const validated = validateMeta(literal);
  if ("error" in validated) return validated;

  // Strip the meta statement; keep the rest verbatim as the script body.
  const scriptBody = script.slice(first.end).replace(/^[;\s]*\n/, "").trimStart();
  return { meta: validated.meta, scriptBody };
}

function isMetaExport(node: AstNode): boolean {
  if (node.type !== "ExportNamedDeclaration") return false;
  const decl = node.declaration as AstNode | undefined;
  if (!decl || decl.type !== "VariableDeclaration") return false;
  if (decl.kind !== "const") return false;
  const declarations = decl.declarations as AstNode[];
  if (!declarations || declarations.length !== 1) return false;
  const d = declarations[0]!;
  const id = d.id as AstNode;
  const init = d.init as AstNode | undefined;
  return id.type === "Identifier" && id.name === "meta" && init?.type === "ObjectExpression";
}

/** Recursively evaluate a pure-literal AST node; throws on anything non-literal. */
function evalLiteral(node: AstNode): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "ArrayExpression":
      return (node.elements as (AstNode | null)[]).map((el) => {
        if (el === null) throw new Error("sparse arrays not allowed");
        if (el.type === "SpreadElement") throw new Error("spread not allowed in meta");
        return evalLiteral(el);
      });
    case "ObjectExpression":
      return evalObject(node);
    case "TemplateLiteral": {
      const expressions = node.expressions as AstNode[];
      if (expressions.length > 0) throw new Error("template interpolation not allowed in meta");
      const quasis = node.quasis as AstNode[];
      return quasis.map((q) => (q.value as { cooked?: string }).cooked ?? "").join("");
    }
    case "UnaryExpression": {
      const arg = node.argument as AstNode;
      if (node.operator === "-" && arg.type === "Literal" && typeof arg.value === "number") {
        return -(arg.value as number);
      }
      throw new Error("only negative-number unary allowed in meta");
    }
    default:
      throw new Error(`non-literal node type in meta: ${node.type}`);
  }
}

function evalObject(node: AstNode): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const prop of node.properties as AstNode[]) {
    if (prop.type !== "Property") throw new Error("only plain properties allowed in meta");
    if (prop.computed) throw new Error("computed keys not allowed in meta");
    if (prop.method || prop.kind !== "init") throw new Error("methods/accessors not allowed in meta");
    out[keyName(prop.key as AstNode)] = evalLiteral(prop.value as AstNode);
  }
  return out;
}

function keyName(key: AstNode): string {
  let name: string;
  if (key.type === "Identifier") name = key.name as string;
  else if (key.type === "Literal") name = String(key.value);
  else throw new Error(`unsupported key type in meta: ${key.type}`);
  if (RESERVED_META_KEYS.has(name)) throw new Error(`reserved key name not allowed in meta: ${name}`);
  return name;
}

function validateMeta(value: unknown): { meta: WorkflowMeta } | { error: string } {
  if (!value || typeof value !== "object") return { error: "meta must be an object" };
  const m = value as Record<string, unknown>;

  const name = m.name;
  if (typeof name !== "string" || name.length === 0) return { error: "meta.name must be a non-empty string" };
  const description = m.description;
  if (typeof description !== "string" || description.length === 0) {
    return { error: "meta.description must be a non-empty string" };
  }

  const title = typeof m.title === "string" && m.title.length > 0 ? m.title : undefined;
  const whenToUse = typeof m.whenToUse === "string" ? m.whenToUse : undefined;
  const phases = parsePhases(m.phases);

  const meta: WorkflowMeta = { name, description };
  if (title) meta.title = title;
  if (whenToUse) meta.whenToUse = whenToUse;
  if (phases) meta.phases = phases;
  return { meta };
}

function parsePhases(raw: unknown): WorkflowPhaseMeta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const phases: WorkflowPhaseMeta[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && "title" in entry) {
      const e = entry as Record<string, unknown>;
      if (typeof e.title === "string") {
        const phase: WorkflowPhaseMeta = { title: e.title };
        if (typeof e.detail === "string") phase.detail = e.detail;
        if (typeof e.model === "string") phase.model = e.model;
        phases.push(phase);
      }
    }
  }
  return phases.length > 0 ? phases : undefined;
}
