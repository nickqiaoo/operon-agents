/**
 * Field-level schemas shared by the plugin manifest and marketplace readers. Both formats are
 * written by third parties, so blank strings mean "absent" and every rejection has to name the
 * field that broke, in the words the author wrote.
 */
import { z } from "zod";

/** A string field whose blank value counts as absent. */
export const optionalText = z
  .string()
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  .optional();

/** A list of strings with blanks dropped; an empty result counts as absent. */
export const optionalTextList = z
  .array(z.string())
  .transform((items) => {
    const kept = items.map((item) => item.trim()).filter((item) => item.length > 0);
    return kept.length > 0 ? kept : undefined;
  })
  .optional();

/** `"a.b.0"` for an issue path, `<root>` for the document itself. */
export function issuePath(issue: z.core.$ZodIssue): string {
  return issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  return `"${issuePath(issue)}" ${issue.message}`;
}
