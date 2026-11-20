import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_OPERATIONS } from "../apps/api/src/services/admin-operation-catalog";
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_TARGET_TYPES,
  DESTRUCTIVE_AUDIT_ACTIONS,
} from "../apps/web/src/components/admin/activity/auditCatalog";
import {
  JOB_ACTOR_LABELS,
  jobActorKey,
} from "../apps/web/src/components/admin/activity/jobActorCatalog";
import {
  adminServiceActionSchema,
  adminServicesBulkActionSchema,
} from "../packages/core/src/api/contracts/service-admin/services";
import { dataExecutionInputSchema } from "../packages/core/src/services/data-manager/contracts/executions";
import de from "../packages/i18n/locales/de.json";
import en from "../packages/i18n/locales/en.json";

/**
 * The admin area words server codes (job types, transit stages, actor labels,
 * audit actions, audit target types) through catalogues keyed by the code.
 * These tests collect the codes
 * from the code that writes them and fail when the catalogue misses one or
 * keeps one nothing writes, so a new job type or audit action cannot reach
 * the screen as a raw English code.
 */

const root = resolve(import.meta.dirname, "..");
const apiRoot = join(root, "apps/api/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

const apiSources = sourceFiles(apiRoot).map((path) => ({
  path: relative(root, path),
  text: readFileSync(path, "utf8"),
}));

function apiSource(path: string): string {
  const source = apiSources.find((file) => file.path === path);
  if (!source) throw new Error(`${path} is gone; update the code collector in this test`);
  return source.text;
}

const DOTTED_CODE = /^[a-z][a-z0-9-]*(\.[a-z0-9_-]+)+$/;
const literals = (text: string) => [...text.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
const matchAll = (text: string, pattern: RegExp) => [...text.matchAll(pattern)];

function required(text: string, pattern: RegExp, what: string): RegExpMatchArray {
  const match = text.match(pattern);
  if (!match) throw new Error(`${what} not found; update the code collector in this test`);
  return match;
}

/** Literal values of a zod schema's discriminator, through unions and objects. */
function zodLiterals(schema: unknown, property: string): string[] {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return [];
  if (def.type === "union")
    return (def.options as unknown[]).flatMap((option) => zodLiterals(option, property));
  if (def.type === "object") {
    const value = (def.shape as Record<string, unknown>)[property];
    const valueDef = (value as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (valueDef?.type === "literal") return (valueDef.values as string[]).map(String);
    if (valueDef?.type === "enum") return Object.values(valueDef.entries as Record<string, string>);
    return [];
  }
  if (def.type === "pipe") return zodLiterals(def.in, property);
  return [];
}

function applicationJobTypes(): string[] {
  const types = new Set<string>();
  for (const { text } of apiSources)
    for (const match of matchAll(
      text,
      /\b(?:register|enqueue|enqueueMaintenance|enqueueStandalone)\(\s*"([^"]+)"/g,
    ))
      types.add(match[1]);
  const runner = apiSource("apps/api/src/services/job-runner.ts");
  for (const name of ["IMMEDIATE_CONFIGURATION_JOB_TYPES", "AGENT_RECOVERABLE_ADMIN_JOB_TYPES"])
    for (const type of literals(required(runner, new RegExp(`${name} = \\[([^\\]]*)\\]`), name)[1]))
      types.add(type);
  for (const match of matchAll(runner, /\btype:\s*((?:\|\s*)?"[^"]+"(?:\s*\|\s*"[^"]+")*)/g))
    for (const type of literals(match[1])) types.add(type);
  const retained = apiSource("apps/api/src/services/retained-maintenance-job.ts");
  for (const type of literals(
    required(retained, /export type RetainedMaintenanceJobType =([^;]+);/, "maintenance types")[1],
  ))
    types.add(type);
  return [...types].filter((type) => DOTTED_CODE.test(type)).sort();
}

const dataManagerKinds = () => [...new Set(zodLiterals(dataExecutionInputSchema, "kind"))].sort();

/** An audit entry object: the `{…}` handed to an audit writer. */
function auditEntries(text: string): string[] {
  const starts = matchAll(
    text,
    /(?:writeAuditLog\(|\.insert\(adminAuditLog\)\s*\.values\(|this\.audit\()\s*\{/g,
  );
  return starts.map((match) => {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < text.length; index++) {
      const char = text[index];
      if (char === '"') index = text.indexOf('"', index + 1);
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) return text.slice(open, index + 1);
    }
    throw new Error("unbalanced audit entry");
  });
}

/** The expression of a top-level property in an object literal's source. */
function propertyExpression(entry: string, name: string): string | undefined {
  let depth = 0;
  for (let index = 0; index < entry.length; index++) {
    const char = entry[index];
    if (char === '"') index = entry.indexOf('"', index + 1);
    else if (char === "`") index = entry.indexOf("`", index + 1);
    else if ("{([".includes(char)) depth++;
    else if ("})]".includes(char)) depth--;
    else if (depth === 1 && entry.startsWith(name, index) && /[\s{,]/.test(entry[index - 1])) {
      const rest = entry.slice(index + name.length);
      const colon = rest.match(/^\s*:/);
      if (!colon) return /^\s*[,}]/.test(rest) ? name : undefined;
      let end = colon[0].length;
      let inner = 0;
      for (; end < rest.length; end++) {
        const next = rest[end];
        if (next === '"') end = rest.indexOf('"', end + 1);
        else if (next === "`") end = rest.indexOf("`", end + 1);
        else if ("{([".includes(next)) inner++;
        else if ("})]".includes(next)) {
          if (inner === 0) break;
          inner--;
        } else if (next === "," && inner === 0) break;
      }
      return rest.slice(colon[0].length, end).trim();
    }
  }
  return undefined;
}

/**
 * Audit actions built from a template or a variable, expanded from the code
 * that bounds their values. A new template or variable writer fails the test
 * until it is described here.
 */
const DERIVED_ACTIONS: Record<string, (file: string) => string[]> = {
  "apps/api/src/routes/admin-operations.ts `data.${definition.id}`": () =>
    ADMIN_OPERATIONS.map((operation) => `data.${operation.id}`),
  "apps/api/src/routes/admin-services.ts `service.${action}`": () =>
    zodLiterals(adminServiceActionSchema, "action").map((action) => `service.${action}`),
  "apps/api/src/routes/admin-services.ts `service.bulk.${action}`": () =>
    zodLiterals(adminServicesBulkActionSchema, "action").map((action) => `service.bulk.${action}`),
  "apps/api/src/routes/admin-standalone-integrations.ts `standalone.${action}`": (file) =>
    literals(required(file, /for \(const action of \[([^\]]+)\] as const\)/, "actions")[1]).map(
      (action) => `standalone.${action}`,
    ),
  "apps/api/src/routes/ambient-places.ts `ambient-places.${action}`": (file) =>
    matchAll(
      required(file, /const operations = \{([^}]+)\}/, "ambient operations")[1],
      /^\s*([a-z]+):/gm,
    )
      .map((match) => match[1])
      .filter((action) => action !== "status")
      .map((action) => `ambient-places.${action}`),
  "apps/api/src/services/dawarich/connection-service.ts action": (file) => [
    ...matchAll(file, /writeLifecycleAudit\(\s*\w+,\s*"([^"]+)"/g).map((match) => match[1]),
    ...literals(required(file, /const action = ([^;]+);/, "timeline action")[1]),
  ],
  "apps/api/src/utils/auth-audit-hook.ts route.action": (file) =>
    matchAll(file, /\baction: "([^"]+)"/g).map((match) => match[1]),
  "apps/api/src/routes/admin-dawarich.ts action": (file) =>
    matchAll(file, /auditFailure\(\s*\w+,\s*"([^"]+)"/g).map((match) => match[1]),
  "apps/api/src/routes/admin-standalone-integrations.ts type": (file) =>
    literals(required(file, /const type =[^?]+\?([^;]+);/, "standalone job type")[1]),
  'apps/api/src/account/account-provisioning.ts input.action === "password" ? "user.password.set" : `user.${input.action}`':
    (file) =>
      literals(
        required(
          file,
          /assistedAccountAction\(\s*input: \{\s*action: ([^;]+);/,
          "assisted account actions",
        )[1],
      ).map((action) => (action === "password" ? "user.password.set" : `user.${action}`)),
  // The writer itself stores whatever its callers pass.
  "apps/api/src/utils/audit-log.ts entry.action": () => [],
};

const DERIVED_TARGET_TYPES: Record<string, (file: string) => string[]> = {
  "apps/api/src/utils/auth-audit-hook.ts route.targetType": (file) =>
    matchAll(file, /\btargetType: "([^"]+)"/g).map((match) => match[1]),
  "apps/api/src/utils/audit-log.ts entry.targetType ?? null": () => [],
};

function auditCodes(
  property: "action" | "targetType",
  derived: Record<string, (file: string) => string[]>,
): string[] {
  const codes = new Set<string>();
  const unexplained: string[] = [];
  for (const { path, text } of apiSources)
    for (const entry of auditEntries(text)) {
      const expression = propertyExpression(entry, property);
      if (expression === undefined) continue;
      // Operands of a comparison choose a branch; they are not written.
      const found = literals(expression.replace(/[!=]==?\s*"[^"]*"|"[^"]*"\s*[!=]==?/g, ""));
      if (found.length > 0 && !expression.includes("`")) {
        for (const code of found) codes.add(code);
        continue;
      }
      const key = `${path} ${expression}`;
      const expand = derived[key];
      if (!expand) unexplained.push(key);
      else for (const code of expand(text)) codes.add(code);
    }
  expect(unexplained, "audit writers whose codes this test cannot collect").toEqual([]);
  return [...codes].sort();
}

const auditActions = () => auditCodes("action", DERIVED_ACTIONS);
const auditTargetTypes = () => auditCodes("targetType", DERIVED_TARGET_TYPES);

/** Catalogue keys cannot hold `.` or `-`; the label helpers read `_` instead. */
const catalogueKey = (code: string) => code.replace(/[.:-]/g, "_");
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function selectBranches(message: string): string[] {
  const body = required(message, /^\{\w+, select,(.*)\}$/s, "select message")[1];
  let depth = 0;
  const keys: string[] = [];
  let token = "";
  for (const char of body) {
    if (char === "{") {
      if (depth === 0) keys.push(token.trim());
      depth++;
      token = "";
    } else if (char === "}") depth--;
    else if (depth === 0) token += char;
  }
  return keys.filter((key) => key !== "other");
}

describe("admin job type catalogue", () => {
  it("collects the job types from the API and data-manager", () => {
    expect(applicationJobTypes()).toEqual(
      expect.arrayContaining(["data.operation", "integration.reload", "configuration.apply"]),
    );
    expect(dataManagerKinds()).toEqual(
      expect.arrayContaining(["transit-sync", "download-osm", "catalog.validate"]),
    );
  });

  it("words every job type the API and data-manager create, and nothing else", () => {
    const expected = sorted([...applicationJobTypes(), ...dataManagerKinds()].map(catalogueKey));
    expect(sorted(Object.keys(en.adminShared.jobTypes))).toEqual(expected);
    expect(sorted(Object.keys(de.adminShared.jobTypes))).toEqual(expected);
  });

  it("words every transit pipeline stage, and nothing else", () => {
    const types = readFileSync(
      join(root, "services/data-manager/src/jobs/transitous/types.ts"),
      "utf8",
    );
    const stages = literals(required(types, /export type StageName =([^;]+);/, "stage names")[1]);
    expect(stages).toEqual(expect.arrayContaining(["motis-import", "promote"]));
    const expected = sorted(stages.map(catalogueKey));
    expect(sorted(Object.keys(en.adminShared.jobStages))).toEqual(expected);
    expect(sorted(Object.keys(de.adminShared.jobStages))).toEqual(expected);
  });

  it("words every data-manager actor label the activity API sends", () => {
    const source = apiSource("apps/api/src/services/activity-jobs.ts");
    const labels = matchAll(source, /\blabel: "([^"]+)"/g).map((match) => match[1]);
    expect(labels.length).toBeGreaterThan(0);
    expect(sorted(labels)).toEqual(sorted(JOB_ACTOR_LABELS));
    const keys = sorted(JOB_ACTOR_LABELS.map(jobActorKey));
    for (const messages of [en, de])
      expect(sorted(selectBranches(messages.adminActivity.actorLabel))).toEqual(keys);
  });
});

describe("admin audit catalogue", () => {
  it("collects literal and derived audit actions", () => {
    expect(auditActions()).toEqual(
      expect.arrayContaining([
        "settings.test_email",
        "data.overture-pull",
        "service.bulk.build",
        "ambient-places.rollback",
        "timeline.switch",
        "user.ban",
      ]),
    );
  });

  it("words and offers every audit action the API records, and nothing else", () => {
    const actions = auditActions();
    const expected = sorted(actions.map(catalogueKey));
    expect(sorted(Object.keys(en.adminShared.auditActions))).toEqual(expected);
    expect(sorted(Object.keys(de.adminShared.auditActions))).toEqual(expected);
    expect(sorted(AUDIT_ACTION_GROUPS.flatMap((group) => group.actions))).toEqual(actions);
    expect([...DESTRUCTIVE_AUDIT_ACTIONS].filter((action) => !actions.includes(action))).toEqual(
      [],
    );
    const groups = sorted(AUDIT_ACTION_GROUPS.map((group) => group.group));
    for (const messages of [en, de])
      expect(sorted(selectBranches(messages.adminActivity.audit.actionGroup))).toEqual(groups);
  });

  it("names and offers every audit target type the API records, and nothing else", () => {
    const types = auditTargetTypes();
    expect(types).toEqual(expect.arrayContaining(["job", "data-manager-job", "user"]));
    expect(sorted(AUDIT_TARGET_TYPES)).toEqual(types);
    const keys = sorted(types.map(catalogueKey));
    for (const messages of [en, de])
      expect(sorted(selectBranches(messages.adminActivity.audit.targetTypeOption))).toEqual(keys);
  });
});
