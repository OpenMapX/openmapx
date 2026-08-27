import { join } from "node:path";
import {
  TrustedAuthorityFilesystem,
  type TrustedAuthorityReadHooks,
} from "./trusted-authority-filesystem";
import { assertTrustedConfigurationSchema } from "./trusted-config-schema";

const FAILED = "Trusted integration registry rejected";
const MAX_MANIFESTS = 256;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readManifest(
  filesystem: TrustedAuthorityFilesystem,
  path: string,
): { id: string; schema: Record<string, unknown>; bytes: number } {
  const bytes = filesystem.readManifest(path, "integration", MAX_MANIFEST_BYTES);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID.test(record.id)) throw new Error();
  const schema = record.configSchema ?? {};
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error();
  assertTrustedConfigurationSchema(schema as Record<string, unknown>);
  return { id: record.id, schema: schema as Record<string, unknown>, bytes: bytes.length };
}

export interface LoadTrustedIntegrationSchemasOptions {
  filesystem?: TrustedAuthorityFilesystem;
  hooks?: TrustedAuthorityReadHooks;
}

export function loadTrustedIntegrationSchemas(
  rootDir: string,
  options: LoadTrustedIntegrationSchemasOptions = {},
): ReadonlyMap<string, Record<string, unknown>> {
  const ownedFilesystem = options.filesystem === undefined;
  const filesystem =
    options.filesystem ??
    new TrustedAuthorityFilesystem(rootDir, process.geteuid?.() ?? 0, options.hooks);
  try {
    const found: Array<readonly [string, Record<string, unknown>]> = [];
    let totalBytes = 0;
    for (const base of [join(rootDir, "integrations"), join(rootDir, "custom_integrations")]) {
      let entries: ReturnType<TrustedAuthorityFilesystem["listDirectory"]>;
      try {
        filesystem.openDirectory(base);
        entries = filesystem.listDirectory(base);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith("_") || !entry.isDirectory() || !ID.test(entry.name)) continue;
        const directory = join(base, entry.name);
        filesystem.openDirectory(directory);
        let item: ReturnType<typeof readManifest>;
        try {
          item = readManifest(filesystem, join(directory, "manifest.json"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (item.id !== entry.name || found.some(([id]) => id === item.id)) throw new Error();
        found.push([item.id, item.schema]);
        totalBytes += item.bytes;
        if (found.length > MAX_MANIFESTS || totalBytes > MAX_TOTAL_BYTES) throw new Error();
      }
    }
    filesystem.recheck();
    return new Map(found.sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    throw new Error(FAILED);
  } finally {
    if (ownedFilesystem) filesystem.close();
  }
}
