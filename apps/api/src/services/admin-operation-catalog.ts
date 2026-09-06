import type { OpsOperation } from "@openmapx/core/ops";
import { z } from "zod";
import {
  countriesSchema,
  optionalRegionSchema,
  regionSchema,
  slugSchema,
} from "./admin-operation-input";

/**
 * Server-authored catalog of the data operations an administrator can queue.
 *
 * One entry describes everything the browser form, the request validation,
 * the audit trail, and the job handler need. The effect is fixed trusted
 * code: it maps validated input onto an ops-agent operation and can never
 * introduce commands, paths, environment variables, or URLs of its own.
 */

export type AdminOperationId =
  | "download-osm"
  | "download-fonts"
  | "update"
  | "convert-overpass"
  | "link"
  | "clean"
  | "generate-api-keys"
  | "overture-sync"
  | "overture-conflate"
  | "search-index-build";

export type AdminOperationGroup = "osm" | "build" | "overture" | "search" | "transit";
export type AdminOperationRisk = "normal" | "destructive";

export interface AdminOperationField {
  /** Must be a key of the operation's input schema. */
  name: string;
  label: string;
  kind: "text" | "boolean" | "select";
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface AdminOperationConfirmation {
  title: string;
  message: string;
}

export type AdminOperationFormValue = string | boolean;

/** The part of a definition the browser receives. */
export interface AdminOperationContract {
  id: AdminOperationId;
  version: number;
  group: AdminOperationGroup;
  title: string;
  description: string;
  risk: AdminOperationRisk;
  confirmation?: AdminOperationConfirmation;
  fields: readonly AdminOperationField[];
  defaults: Readonly<Record<string, AdminOperationFormValue>>;
}

export interface AdminOperationDefinition<S extends z.ZodObject> extends AdminOperationContract {
  input: S;
  /** Fixed trusted effect. Pure: validated input to an agent operation. */
  effect: (input: z.output<S>) => OpsOperation;
  /** Redacted, human-readable lines shown before confirmation. Pure. */
  preview: (input: z.output<S>) => string[];
  /** Redacted audit details. Defaults to the validated input. Pure. */
  audit?: (input: z.output<S>) => Record<string, unknown>;
  /**
   * Input that satisfies the schema, used by startup validation when the
   * defaults alone do not (for example a required region).
   */
  example?: Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous catalog entries
export type AnyAdminOperationDefinition = AdminOperationDefinition<z.ZodObject<any>>;

export type AdminOperationParseResult<Input = Record<string, unknown>> =
  | { ok: true; input: Input }
  | { ok: false; error: string; issues: Array<{ path: string; message: string }> };

function defineOperation<S extends z.ZodObject>(
  definition: AdminOperationDefinition<S>,
): AdminOperationDefinition<S> {
  return definition;
}

const regionField = (helpText: string): AdminOperationField => ({
  name: "region",
  label: "Region",
  kind: "text",
  placeholder: "e.g. europe/germany",
  helpText,
});

const requiredRegionField = (helpText: string): AdminOperationField => ({
  ...regionField(helpText),
  required: true,
});

const withRegion = (label: string, regionId: string | undefined) =>
  regionId ? `${label} ${regionId}` : `${label} (configured default region)`;

const TRANSITOUS_API_KEY_CATALOG_REVISION = "transitous-fixed-v1";

export const ADMIN_OPERATIONS: readonly AnyAdminOperationDefinition[] = [
  defineOperation({
    id: "download-osm",
    version: 1,
    group: "osm",
    title: "Download OSM",
    description: "Downloads the OSM extract for a region into the data directory.",
    risk: "normal",
    input: z.strictObject({ region: optionalRegionSchema }),
    fields: [regionField("Leave empty to use the configured default region.")],
    defaults: { region: "" },
    effect: (input) => ({
      kind: "data.downloadOsm",
      ...(input.region ? { regionId: input.region } : {}),
    }),
    preview: (input) => [withRegion("Download OSM extract for", input.region)],
  }),
  defineOperation({
    id: "download-fonts",
    version: 1,
    group: "build",
    title: "Download Map Glyphs",
    description: "Downloads the font glyphs the tile server needs to render labels.",
    risk: "normal",
    input: z.strictObject({}),
    fields: [],
    defaults: {},
    effect: () => ({ kind: "data.downloadFonts" }),
    preview: () => ["Download map glyphs into the data directory"],
  }),
  defineOperation({
    id: "update",
    version: 1,
    group: "osm",
    title: "Full Update Pipeline",
    description: "Refreshes OSM data, then runs the dependent build and link steps.",
    risk: "normal",
    input: z.strictObject({
      region: optionalRegionSchema,
      countries: countriesSchema,
      failFast: z.boolean().default(false),
    }),
    fields: [
      regionField("Leave empty to use the configured default region."),
      {
        name: "countries",
        label: "Countries",
        kind: "text",
        placeholder: "de,at,ch",
        helpText: "Optional comma-separated ISO country codes to limit transit imports.",
      },
      {
        name: "failFast",
        label: "Fail fast",
        kind: "boolean",
        helpText: "Stop at the first failing step instead of continuing.",
      },
    ],
    defaults: { region: "", countries: "", failFast: false },
    effect: (input) => ({
      kind: "data.update",
      ...(input.region ? { regionId: input.region } : {}),
      ...(input.countries ? { countryCodes: input.countries } : {}),
      ...(input.failFast ? { failFast: true } : {}),
    }),
    preview: (input) => [
      withRegion("Update OSM data and dependent builds for", input.region),
      input.countries
        ? `Limit transit imports to ${input.countries.join(", ")}`
        : "Import transit for all configured countries",
      input.failFast ? "Stop at the first failing step" : "Continue past failing steps",
    ],
  }),
  defineOperation({
    id: "convert-overpass",
    version: 1,
    group: "build",
    title: "Convert for Overpass",
    description: "Converts the OSM extract into the Overpass database format.",
    risk: "normal",
    input: z.strictObject({ region: optionalRegionSchema }),
    fields: [regionField("Leave empty to use the configured default region.")],
    defaults: { region: "" },
    effect: (input) => ({
      kind: "data.convertOverpass",
      ...(input.region ? { regionId: input.region } : {}),
    }),
    preview: (input) => [withRegion("Convert OSM extract for Overpass:", input.region)],
  }),
  defineOperation({
    id: "link",
    version: 1,
    group: "build",
    title: "Hardlink Sync",
    description: "Applies and prunes the hardlink plan that shares data between services.",
    risk: "normal",
    input: z.strictObject({}),
    fields: [],
    defaults: {},
    effect: () => ({ kind: "data.link" }),
    preview: () => ["Apply the hardlink plan and prune stale links"],
  }),
  defineOperation({
    id: "clean",
    version: 1,
    group: "osm",
    title: "Cleanup Data",
    description: "Removes downloaded and generated data files for a data type.",
    risk: "destructive",
    confirmation: {
      title: "Confirm data cleanup",
      message:
        "This removes local data files for the selected target and may require full rebuilds before services work again.",
    },
    input: z.strictObject({ target: slugSchema }),
    fields: [
      {
        name: "target",
        label: "Target",
        kind: "text",
        placeholder: "all | osm | gtfs | overpass",
        helpText: "Data type to remove, or all.",
        required: true,
      },
    ],
    defaults: { target: "all" },
    effect: (input) => ({ kind: "data.clean", dataTypeId: input.target }),
    preview: (input) => [
      `Remove local data files for target ${input.target}`,
      "Services depending on that data need a rebuild afterwards",
    ],
  }),
  defineOperation({
    id: "generate-api-keys",
    version: 1,
    group: "transit",
    title: "Generate Transitous API-Key Template",
    description: "Writes the API-key template for the pinned Transitous catalog revision.",
    risk: "normal",
    input: z.strictObject({}),
    fields: [],
    defaults: {},
    effect: () => ({
      kind: "data.generateApiKeys",
      catalogRevisionId: TRANSITOUS_API_KEY_CATALOG_REVISION,
    }),
    preview: () => [
      `Generate the API-key template for catalog revision ${TRANSITOUS_API_KEY_CATALOG_REVISION}`,
    ],
  }),
  defineOperation({
    id: "overture-sync",
    version: 1,
    group: "overture",
    title: "Overture Sync",
    description: "Downloads and imports the Overture Places release for a region.",
    risk: "normal",
    input: z.strictObject({ region: regionSchema }),
    fields: [requiredRegionField("Region whose Overture partition is imported.")],
    defaults: { region: "" },
    example: { region: "europe/germany" },
    effect: (input) => ({ kind: "data.overtureSync", regionId: input.region }),
    preview: (input) => [`Sync Overture Places for ${input.region}`],
  }),
  defineOperation({
    id: "overture-conflate",
    version: 1,
    group: "overture",
    title: "Overture Conflation",
    description: "Links Overture places to OSM features for a region.",
    risk: "normal",
    input: z.strictObject({ region: regionSchema, restart: z.boolean().default(false) }),
    fields: [
      requiredRegionField("Region whose Overture data is conflated."),
      {
        name: "restart",
        label: "Restart from scratch",
        kind: "boolean",
        helpText: "Discard resumable progress and conflate the whole region again.",
      },
    ],
    defaults: { region: "", restart: false },
    example: { region: "europe/germany" },
    effect: (input) => ({
      kind: "data.overtureConflate",
      regionId: input.region,
      ...(input.restart ? { restart: true } : {}),
    }),
    preview: (input) => [
      `Conflate Overture places with OSM for ${input.region}`,
      input.restart ? "Restart from scratch" : "Resume previous progress where possible",
    ],
  }),
  defineOperation({
    id: "search-index-build",
    version: 1,
    group: "search",
    title: "Search Index Build",
    description: "Builds the OSM code and alias search index for a region.",
    risk: "normal",
    input: z.strictObject({ region: regionSchema }),
    fields: [requiredRegionField("Region whose OSM extract feeds the index.")],
    defaults: { region: "" },
    example: { region: "europe/germany" },
    effect: (input) => ({ kind: "data.searchIndexBuild", regionId: input.region }),
    preview: (input) => [`Build the search index for ${input.region}`],
  }),
];

const byId = new Map<string, AnyAdminOperationDefinition>(
  ADMIN_OPERATIONS.map((definition) => [definition.id, definition]),
);

export function getAdminOperation(id: string): AnyAdminOperationDefinition | undefined {
  return byId.get(id);
}

export function parseAdminOperationInput<S extends z.ZodObject>(
  definition: AdminOperationDefinition<S>,
  raw: unknown,
): AdminOperationParseResult<z.output<S>> {
  const result = definition.input.safeParse(raw ?? {});
  if (result.success) return { ok: true, input: result.data };
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const first = issues[0];
  const error = first
    ? first.path
      ? `${first.path}: ${first.message}`
      : first.message
    : "Invalid input";
  return { ok: false, error, issues };
}

/**
 * Throws when the catalog is internally inconsistent. Runs at startup so the
 * process never boots with a form that cannot be submitted or an effect that
 * escapes the data operation family.
 */
export function validateAdminOperationCatalog(
  definitions: readonly AnyAdminOperationDefinition[] = ADMIN_OPERATIONS,
): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    const label = `Admin operation "${definition.id}"`;
    if (seen.has(definition.id)) throw new Error(`${label} is a duplicate id`);
    seen.add(definition.id);
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new Error(`${label} needs an integer version >= 1`);
    }
    if (definition.risk === "destructive" && !definition.confirmation) {
      throw new Error(`${label} is destructive and needs confirmation copy`);
    }
    const schemaKeys = new Set(Object.keys(definition.input.shape));
    const fieldNames = new Set<string>();
    for (const field of definition.fields) {
      if (fieldNames.has(field.name)) throw new Error(`${label} repeats field ${field.name}`);
      fieldNames.add(field.name);
      if (!schemaKeys.has(field.name)) {
        throw new Error(`${label} has form field ${field.name} without a schema key`);
      }
      if (field.kind === "select" && (!field.options || field.options.length === 0)) {
        throw new Error(`${label} select field ${field.name} needs options`);
      }
    }
    for (const key of schemaKeys) {
      if (!fieldNames.has(key))
        throw new Error(`${label} has schema key ${key} without a form field`);
    }
    for (const key of Object.keys(definition.defaults)) {
      if (!fieldNames.has(key)) throw new Error(`${label} has a default for unknown field ${key}`);
    }
    const sample = parseAdminOperationInput(definition, definition.example ?? definition.defaults);
    if (!sample.ok) {
      throw new Error(`${label} needs an example that satisfies its schema: ${sample.error}`);
    }
    const effect = definition.effect(sample.input);
    if (typeof effect.kind !== "string" || !effect.kind.startsWith("data.")) {
      throw new Error(`${label} effect must stay inside the data. operation family`);
    }
    if (definition.preview(sample.input).length === 0) {
      throw new Error(`${label} preview must produce at least one line`);
    }
  }
}

export function describeAdminOperationCatalog(
  definitions: readonly AnyAdminOperationDefinition[] = ADMIN_OPERATIONS,
): AdminOperationContract[] {
  return definitions.map((definition) => ({
    id: definition.id,
    version: definition.version,
    group: definition.group,
    title: definition.title,
    description: definition.description,
    risk: definition.risk,
    ...(definition.confirmation ? { confirmation: definition.confirmation } : {}),
    fields: definition.fields,
    defaults: definition.defaults,
  }));
}
