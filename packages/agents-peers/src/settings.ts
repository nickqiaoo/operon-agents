/**
 * The Teams settings a file bundle of `peers` declares in its manifest, and how they become
 * `peers()` options.
 *
 * A host that loads `peers` from a bundle does not compute its options: the bundle's manifest
 * carries `PEERS_SETTINGS_SCHEMA` as its `settings`, the framework stores and validates what the
 * user sets, a host renders it with its generic settings form, and the bundle turns the value
 * into options with `peersOptionsFromSettings(host.settings)`. A settings change reloads the
 * extension, so it lands without any host wiring.
 *
 * No teammate types are built in. Which types a product starts with (and its budget) is the
 * product's decision: its packaging writes them into the manifest schema's `default`s.
 */
import type { SessionConfig, SettingsSchema } from "operon-agents";
import type { PeerOptions, TeammateSessionOptions } from "./network.ts";
import type { PeerBudget } from "./stats.ts";

/** One teammate type as the user configures it. */
export interface PeersTypeSettings {
  /** What a teammate of this type is called — the session title reads `<name> · <title>`. */
  readonly title: string;
  /** One line on what it is for, shown on the roster. */
  readonly description?: string;
  /** `provider/model`. Absent → the lead's current model. */
  readonly model?: string;
  /** Absent → `workspace`. */
  readonly permissionMode?: "manual" | "workspace" | "auto" | "yolo";
  /** Appended to the teammate's system prompt, after the member protocol. */
  readonly instructions?: string;
}

/** The value `PEERS_SETTINGS_SCHEMA` describes — what `host.settings` holds for a bundle that declares it. */
export interface PeersSettings {
  readonly budget?: PeerBudget;
  /** Teammate types by key (`coder`) — what `Team spawn`'s `type` picks from. */
  readonly types?: Readonly<Record<string, PeersTypeSettings>>;
}

/** The key a teammate type is stored under: what the model passes as `Team spawn`'s `type`. */
export const TEAMMATE_TYPE_KEY_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";

/**
 * The manifest `settings` of a `peers` bundle — plain JSON, so a packaging script can write it
 * into `manifest.json` (adding its product's `default`s for `types` and the `budget` fields).
 */
export const PEERS_SETTINGS_SCHEMA = {
  type: "object",
  properties: {
    budget: {
      type: "object",
      title: "Budget",
      description: "Fleet-wide spend ceilings. Reaching one pauses peer messaging and spawning; agents already running finish their work.",
      "x-order": 2,
      properties: {
        maxWakes: {
          type: "integer",
          minimum: 0,
          title: "Max wakes",
          description: "Deliveries that start a turn on an idle or parked teammate — each one is a model call nobody explicitly asked for. Empty = unlimited.",
        },
        maxTotalTokens: {
          type: "integer",
          minimum: 0,
          title: "Max total tokens",
          description: "Tokens spent by every agent on the roster together. Empty = unlimited.",
        },
        maxTotalCost: {
          type: "number",
          minimum: 0,
          title: "Max total cost",
          description: "Cost spent by every agent on the roster together. Empty = unlimited.",
        },
      },
    },
    types: {
      type: "object",
      title: "Teammate types",
      description: "What a lead may spawn. The model only picks a type and a name; everything else a teammate is comes from here.",
      "x-order": 1,
      propertyNames: { pattern: TEAMMATE_TYPE_KEY_PATTERN },
      additionalProperties: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", title: "Title", maxLength: 64, "x-order": 1 },
          description: { type: "string", title: "Description", description: "Shown on the roster so a lead knows who to ask.", "x-order": 2 },
          model: { type: "string", format: "model", title: "Model", description: "Empty = the lead's current model.", "x-order": 3 },
          permissionMode: { type: "string", format: "permission-mode", title: "Permission mode", default: "workspace", "x-order": 4 },
          instructions: {
            type: "string",
            title: "Instructions",
            description: "Appended to the teammate's system prompt.",
            "x-multiline": true,
            "x-order": 5,
          },
        },
      },
    },
  },
} as const satisfies SettingsSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `peers()` options a settings value stands for: the `budget` as it is, and one `teammates`
 * entry per type — its title, description, instructions, model (left out when unset, so the
 * teammate takes its lead's) and permission mode. Pure; a value that does not have the shape is
 * read as far as it does (the framework already resolved it against the schema).
 */
export function peersOptionsFromSettings(settings: unknown): Pick<PeerOptions, "budget" | "teammates"> {
  if (!isRecord(settings)) return {};
  const { budget, types } = settings as PeersSettings;
  const teammates: Record<string, TeammateSessionOptions> = {};
  if (isRecord(types)) {
    for (const [type, value] of Object.entries(types)) {
      if (!isRecord(value)) continue;
      const entry = value as Partial<PeersTypeSettings>;
      const config: SessionConfig = {
        ...(typeof entry.model === "string" && entry.model.trim() !== "" ? { model: entry.model.trim() } : {}),
        ...(typeof entry.permissionMode === "string" ? { permission: { mode: entry.permissionMode } } : {}),
      };
      teammates[type] = {
        ...(typeof entry.title === "string" && entry.title.trim() !== "" ? { typeTitle: entry.title.trim() } : {}),
        ...(typeof entry.description === "string" && entry.description.trim() !== "" ? { description: entry.description.trim() } : {}),
        ...(typeof entry.instructions === "string" && entry.instructions.trim() !== "" ? { instructions: entry.instructions.trim() } : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
      };
    }
  }
  return {
    ...(isRecord(budget) ? { budget: budget as PeerBudget } : {}),
    ...(isRecord(types) ? { teammates } : {}),
  };
}
