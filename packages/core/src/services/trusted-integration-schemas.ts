import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BuiltInManifestSource,
  checkoutBuiltInIntegrationManifests,
  readRegularFileBytes,
} from "./built-in-service-source";
import { assertTrustedConfigurationSchema } from "./configuration-schema";
import { embeddedBuiltInIntegrationManifests } from "./embedded-built-in-services";
import { acceptedManifestDigests, readIntegrationRecords, sha256Hex } from "./integration-records";

const FAILED = "Trusted integration registry rejected";
const MAX_MANIFESTS = 256;
/** The largest integration manifest the operations agent reads. */
export const MAX_INTEGRATION_MANIFEST_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseSchema(
  bytes: Uint8Array,
  expectedId: string,
): { id: string; schema: Record<string, unknown> } {
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID.test(record.id) || record.id !== expectedId) {
    throw new Error();
  }
  const schema = record.configSchema ?? {};
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error();
  assertTrustedConfigurationSchema(schema as Record<string, unknown>);
  return { id: record.id, schema: schema as Record<string, unknown> };
}

/** A regular file of at most `maxBytes`, opened without following a symbolic link. */
function readManifestFile(path: string, maxBytes: number): Buffer {
  // Read-only: nothing is created, so the mode is never applied.
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size < 2 || stats.size > maxBytes) throw new Error();
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Throws unless the operations agent would load `directory` as the installed
 * integration `id`: its `manifest.json` a regular file of at most 128 KiB, in
 * UTF-8, declaring `id` and a configuration schema the agent accepts. The
 * installer runs it on what it is about to install.
 */
export function assertTrustedIntegrationDirectory(directory: string, id: string): void {
  parseSchema(
    readManifestFile(join(directory, "manifest.json"), MAX_INTEGRATION_MANIFEST_BYTES),
    id,
  );
}

export interface LoadTrustedIntegrationSchemasOptions {
  /**
   * The built-in integration manifests. Defaults to the release's copies in
   * the ops-agent bundle, or to the checkout's `integrations/` from source.
   */
  builtIns?: BuiltInManifestSource;
  /** Owner of the agent's records. Defaults to the effective uid. */
  uid?: number;
  /** Called just before each installed manifest is read (tests). */
  beforeInstalledManifestRead?(integrationId: string, path: string): void;
}

export interface IntegrationAuthorityProblem {
  integrationId: string;
  problem: string;
}

export interface TrustedIntegrationAuthority {
  schemas: ReadonlyMap<string, Record<string, unknown>>;
  /** Installed integrations the agent does not load, and why. */
  problems: IntegrationAuthorityProblem[];
}

const REINSTALL =
  "Install it again from the admin panel or with `pnpm openmapx integrations install`.";

/**
 * The configuration schemas of every built-in and installed integration, as
 * the operations agent and the fixed CLI it runs authorize them.
 *
 * Built-in manifests come from the release when bundled. An installed
 * integration under `custom_integrations/` is loaded only as the agent
 * recorded it when it installed it: its `manifest.json` must have exactly the
 * bytes of the record, which lives in the agent's own state directory. File
 * owners and modes in `custom_integrations/` decide nothing. One that is not
 * recorded, or no longer matches, is left out and reported, so it cannot keep
 * the agent from authorizing the others.
 */
export function loadTrustedIntegrationAuthority(
  rootDir: string,
  options: LoadTrustedIntegrationSchemasOptions = {},
): TrustedIntegrationAuthority {
  const found = new Map<string, Record<string, unknown>>();
  const problems: IntegrationAuthorityProblem[] = [];
  let totalBytes = 0;
  let records: ReturnType<typeof readIntegrationRecords>;
  try {
    const builtIns =
      options.builtIns ??
      embeddedBuiltInIntegrationManifests() ??
      checkoutBuiltInIntegrationManifests(rootDir);
    for (const id of builtIns.ids) {
      if (!ID.test(id)) throw new Error();
      const bytes = readRegularFileBytes(builtIns.manifestPath(id), MAX_INTEGRATION_MANIFEST_BYTES);
      const item = parseSchema(bytes, id);
      if (found.has(item.id)) throw new Error();
      found.set(item.id, item.schema);
      totalBytes += bytes.length;
    }
    if (found.size > MAX_MANIFESTS || totalBytes > MAX_TOTAL_BYTES) throw new Error();
    records = readIntegrationRecords(join(rootDir, "infra", "docker"), options.uid);
  } catch {
    // The release's own manifests, or the agent's own records directory.
    throw new Error(FAILED);
  }

  const custom = join(rootDir, "custom_integrations");
  for (const integrationId of records.unreadable) {
    problems.push({ integrationId, problem: `Its install record could not be read. ${REINSTALL}` });
  }
  for (const [integrationId, record] of records.records) {
    const accepted = acceptedManifestDigests(record);
    if (accepted.size === 0) {
      problems.push({
        integrationId,
        problem: `${record.reason ?? "It is not installed."} ${REINSTALL}`,
      });
      continue;
    }
    if (found.has(integrationId)) {
      problems.push({ integrationId, problem: "Its id is used by a built-in integration." });
      continue;
    }
    const path = join(custom, integrationId, "manifest.json");
    let bytes: Buffer;
    try {
      options.beforeInstalledManifestRead?.(integrationId, path);
      bytes = readManifestFile(path, MAX_INTEGRATION_MANIFEST_BYTES);
    } catch {
      problems.push({ integrationId, problem: `Its manifest.json is missing. ${REINSTALL}` });
      continue;
    }
    if (!accepted.has(sha256Hex(bytes))) {
      problems.push({
        integrationId,
        problem: `Its manifest.json no longer matches what the operations agent installed. ${REINSTALL}`,
      });
      continue;
    }
    let item: ReturnType<typeof parseSchema>;
    try {
      item = parseSchema(bytes, integrationId);
    } catch {
      problems.push({ integrationId, problem: "Its manifest.json is not one the agent accepts." });
      continue;
    }
    if (found.size + 1 > MAX_MANIFESTS || totalBytes + bytes.length > MAX_TOTAL_BYTES) {
      problems.push({ integrationId, problem: "Too many integrations are installed." });
      continue;
    }
    found.set(item.id, item.schema);
    totalBytes += bytes.length;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(custom, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    // No custom_integrations directory: nothing is installed.
  }
  for (const name of entries.sort()) {
    if (records.records.has(name) || records.unreadable.includes(name)) continue;
    problems.push({
      integrationId: name,
      problem: `It was not installed through the operations agent. ${REINSTALL}`,
    });
  }
  return {
    schemas: new Map([...found].sort(([a], [b]) => a.localeCompare(b))),
    problems: problems.sort((a, b) => a.integrationId.localeCompare(b.integrationId)),
  };
}

/** The schemas of {@link loadTrustedIntegrationAuthority}. */
export function loadTrustedIntegrationSchemas(
  rootDir: string,
  options: LoadTrustedIntegrationSchemasOptions = {},
): ReadonlyMap<string, Record<string, unknown>> {
  return loadTrustedIntegrationAuthority(rootDir, options).schemas;
}
