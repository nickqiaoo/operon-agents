/**
 * Tasks where one program should beat a string of direct tool calls: each needs the same
 * operation over several files, or a decision that depends on what earlier reads returned.
 * Every case is answerable with Read/Grep/Glob alone, and its answer is fixed by the files.
 */

export interface CodeModeEvalCase {
  readonly id: string;
  /** Files to lay out in the working directory before the prompt. */
  readonly files: Readonly<Record<string, string>>;
  readonly prompt: string;
  /** Does the model's final answer say the right thing? Loose on the wording, strict on the fact. */
  readonly expect: (answer: string) => boolean;
}

const has = (answer: string, ...needles: readonly string[]): boolean => needles.every((needle) => answer.toLowerCase().includes(needle.toLowerCase()));
const lacks = (answer: string, ...needles: readonly string[]): boolean => needles.every((needle) => !answer.toLowerCase().includes(needle.toLowerCase()));

export const CODE_MODE_CASES: readonly CodeModeEvalCase[] = [
  {
    id: "todo-count",
    files: {
      "src/a.ts": "export const a = 1; // TODO: rename\n// TODO: remove\nexport const b = 2;\n",
      "src/b.ts": "export function f() {\n  return 1; // TODO: implement\n}\n",
      "src/c.ts": "export const c = 3;\n",
      "src/d.ts": "// TODO: split this file\n// TODO: add tests\nexport const d = 4; // TODO: type\n",
      "src/e.ts": "export const e = 5;\n",
      "src/f.ts": "export const f = 6; // todo (lowercase, does not count)\n",
    },
    prompt: "How many lines contain the marker TODO (uppercase) across the .ts files under src/? Reply with just the number.",
    expect: (answer) => /\b6\b/.test(answer),
  },
  {
    id: "config-key",
    files: {
      "config/alpha.yaml": "name: alpha\nretries: 3\n",
      "config/beta.yaml": "name: beta\nretries: 5\n",
      "config/gamma.yaml": "name: gamma\ntimeout: 30\n",
      "config/delta.yaml": "name: delta\nretries: 5\ntimeout: 10\n",
      "config/epsilon.yaml": "name: epsilon\nretries: 1\n",
      "config/zeta.yaml": "name: zeta\n",
    },
    prompt: "Which config files under config/ set retries to exactly 5? List the file names.",
    expect: (answer) => has(answer, "beta", "delta") && lacks(answer, "alpha", "epsilon", "gamma", "zeta"),
  },
  {
    id: "longest-file",
    files: {
      "notes/one.md": "a\nb\nc\n",
      "notes/two.md": "a\nb\nc\nd\ne\nf\ng\nh\n",
      "notes/three.md": "a\n",
      "notes/four.md": "a\nb\nc\nd\ne\n",
      "notes/five.md": "a\nb\n",
    },
    prompt: "Which file under notes/ has the most lines? Reply with the file name.",
    expect: (answer) => has(answer, "two.md") && lacks(answer, "four.md"),
  },
  {
    id: "mentions",
    files: {
      "docs/billing.md": "# Billing\nA refund is issued within 5 days.\n",
      "docs/shipping.md": "# Shipping\nOrders ship in 2 days.\n",
      "docs/returns.md": "# Returns\nAsk for a refund at the counter.\n",
      "docs/faq.md": "# FAQ\nRefunds: see billing.\n",
      "docs/legal.md": "# Legal\nNo warranty.\n",
    },
    prompt: "Which markdown files under docs/ mention refunds (the word refund or refunds, any case)? List the file names.",
    expect: (answer) => has(answer, "billing", "returns", "faq") && lacks(answer, "shipping", "legal"),
  },
  {
    id: "importers",
    files: {
      "src/util.ts": "export const util = 1;\n",
      "src/app.ts": 'import { util } from "./util";\nexport const app = util;\n',
      "src/cli.ts": 'import { app } from "./app";\nexport const cli = app;\n',
      "src/worker.ts": 'import { util } from "./util";\nexport const worker = util + 1;\n',
      "src/types.ts": "export type T = string;\n",
    },
    prompt: 'Which files under src/ import from "./util"? List the file names (not util.ts itself).',
    expect: (answer) => has(answer, "app.ts", "worker.ts") && lacks(answer, "cli.ts", "types.ts"),
  },
];
