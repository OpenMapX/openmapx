import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type BuiltInManifestSource,
  checkoutBuiltInIntegrationManifests,
  readRegularFileBytes,
} from "./built-in-service-source";
import { assertTrustedConfigurationSchema } from "./configuration-schema";
import { embeddedBuiltInIntegrationManifests } from "./embedded-built-in-services";
import {
  TrustedAuthorityFilesystem,
  type TrustedAuthorityReadHooks,
} from "./trusted-authority-filesystem";

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

function readIntegrationManifest(filesystem: TrustedAuthorityFilesystem, directory: string) {
  return filesystem.readManifest(
    join(directory, "manifest.json"),
    "integration",
    MAX_INTEGRATION_MANIFEST_BYTES,
  );
}

/**
 * Throws unless the operations agent would load `directory` as the installed
 * integration `id`: the directory and its `manifest.json` owned by `uid` and
 * not group- or other-writable, the manifest a single-link regular file of at
 * most 128 KiB, in UTF-8, declaring `id` and a configuration schema the agent
 * accepts. The installer runs it on what it is about to install, so an
 * installed integration cannot stop the agent from loading the others.
 */
export function assertTrustedIntegrationDirectory(
  directory: string,
  id: string,
  uid: number = process.geteuid?.() ?? 0,
): void {
  const filesystem = new TrustedAuthorityFilesystem(directory, uid);
  try {
    parseSchema(readIntegrationManifest(filesystem, directory), id);
    filesystem.recheck();
  } finally {
    filesystem.close();
  }
}

export interface LoadTrustedIntegrationSchemasOptions {
  /**
   * The built-in integration manifests. Defaults to the release's copies in
   * the ops-agent bundle, or to the checkout's `integrations/` from source.
   */
  builtIns?: BuiltInManifestSource;
  /** Owner `custom_integrations/` and its contents must have. Defaults to the effective uid. */
  uid?: number;
  hooks?: TrustedAuthorityReadHooks;
}

/**
 * The configuration schemas of every built-in and installed integration, as
 * the operations agent and the fixed CLI it runs authorize them.
 *
 * Built-in manifests come from the release when bundled, so the checkout's
 * `integrations/` and its file permissions do not decide them. Installed
 * integrations under `custom_integrations/` are not part of any release:
 * they keep the owner and mode checks, anchored at that directory. The
 * installer writes fixed modes and refuses anything these checks would
 * reject (`assertTrustedIntegrationDirectory`), and the configuration writer
 * removes the group and other write earlier installs left
 * (`tightenCustomIntegrations`).
 */
export function loadTrustedIntegrationSchemas(
  rootDir: string,
  options: LoadTrustedIntegrationSchemasOptions = {},
): ReadonlyMap<string, Record<string, unknown>> {
  let filesystem: TrustedAuthorityFilesystem | undefined;
  try {
    const found = new Map<string, Record<string, unknown>>();
    let totalBytes = 0;
    const add = (id: string, bytes: Uint8Array) => {
      const item = parseSchema(bytes, id);
      if (found.has(item.id)) throw new Error();
      found.set(item.id, item.schema);
      totalBytes += bytes.length;
      if (found.size > MAX_MANIFESTS || totalBytes > MAX_TOTAL_BYTES) throw new Error();
    };
    const builtIns =
      options.builtIns ??
      embeddedBuiltInIntegrationManifests() ??
      checkoutBuiltInIntegrationManifests(rootDir);
    for (const id of builtIns.ids) {
      if (!ID.test(id)) throw new Error();
      add(id, readRegularFileBytes(builtIns.manifestPath(id), MAX_INTEGRATION_MANIFEST_BYTES));
    }

    const custom = join(rootDir, "custom_integrations");
    let customExists = true;
    try {
      lstatSync(custom);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      customExists = false;
    }
    if (customExists) {
      filesystem = new TrustedAuthorityFilesystem(
        custom,
        options.uid ?? process.geteuid?.() ?? 0,
        options.hooks,
      );
      for (const entry of filesystem.listDirectory(custom)) {
        if (entry.name.startsWith("_") || !entry.isDirectory() || !ID.test(entry.name)) continue;
        const directory = join(custom, entry.name);
        filesystem.openDirectory(directory);
        let bytes: Uint8Array;
        try {
          bytes = readIntegrationManifest(filesystem, directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        add(entry.name, bytes);
      }
      filesystem.recheck();
    }
    return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    throw new Error(FAILED);
  } finally {
    filesystem?.close();
  }
}
