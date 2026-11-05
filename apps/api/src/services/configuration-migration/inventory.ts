/** Safe portable projection. Strict acquisition never falls back to defaults after an error. */
import type { ConfigurationOwnership } from "@openmapx/core/api-contracts";
import type { ConfigurationSourcesInspection } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import type {
  ConfigurationMigrationDocument,
  MigrationPrerequisite,
} from "../../../../../packages/core/src/api/contracts/integration-admin/configuration-migration";
import { configurationMigrationInventorySchema } from "../../../../../packages/core/src/api/contracts/integration-admin/configuration-migration";
import { db } from "../../db";
import { systemSettings } from "../../db/schema";
import {
  type AdministrativeConfigurationReadContext,
  withAdministrativeConfigurationRead,
} from "../administrative-configuration-writer-owner";
import {
  integrationOwnershipSnapshot,
  projectFieldOwnership,
  serviceOwnershipSnapshot,
} from "../configuration-ownership-view";
import { matchesDeclaredType, SETTING_DEFS } from "../settings";
import { standaloneInventory } from "../standalone-integrations/ownership";

export { migrationSources } from "./sources";

import { migrationSources } from "./sources";
export async function collectPortableServiceConfiguration(
  read?: AdministrativeConfigurationReadContext,
  source?: ConfigurationSourcesInspection,
): Promise<ConfigurationMigrationDocument["serviceConfigs"]> {
  if (!read || !source)
    return withAdministrativeConfigurationRead({}, async (context) =>
      collectPortableServiceConfiguration(context, await migrationSources()),
    );
  const entries: ConfigurationMigrationDocument["serviceConfigs"] = [];
  for (const service of read.services) {
    const id = service.manifest.id,
      snapshot = await serviceOwnershipSnapshot(id, read, source),
      row = read.serviceRows.find((r) => r.serviceId === id),
      config: Record<string, never> = {};
    for (const [key, ownership] of Object.entries(snapshot.ownership))
      if (
        !ownership.secret &&
        ownership.source === "database" &&
        ownership.writable &&
        row &&
        Object.hasOwn(row.config, key)
      )
        config[key] = row.config[key] as never;
    if (Object.keys(config).length) entries.push({ serviceId: id, config });
  }
  return entries;
}
export async function configurationMigrationInventory() {
  const source = await migrationSources(),
    installations = await standaloneInventory();
  return withAdministrativeConfigurationRead({}, async (read) => {
    const document: ConfigurationMigrationDocument = {
      format: "openmapx-configuration",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {},
      integrations: [],
      serviceConfigs: await collectPortableServiceConfiguration(read, source),
      bindings: (read.bindingRows ?? []).map(({ integrationId, capability, serviceId }) => ({
        integrationId,
        capability,
        serviceId,
      })),
      installations: installations.entries,
      prerequisites: [],
    };
    const fields: Array<{
      scope: MigrationPrerequisite["scope"];
      id: string;
      key: string;
      ownership: ConfigurationOwnership;
      included: boolean;
    }> = [];
    const add = (
      scope: MigrationPrerequisite["scope"],
      id: string,
      ownership: Record<string, ConfigurationOwnership>,
    ) => {
      for (const [key, value] of Object.entries(ownership)) {
        const { envVar: _envVar, ...safe } = value;
        fields.push({
          scope,
          id,
          key,
          ownership: safe,
          included: !value.secret && value.source === "database" && value.writable,
        });
        if (value.secret || ["env", "config.json"].includes(value.source))
          document.prerequisites.push({
            scope,
            id,
            key,
            source: value.source,
            reason: value.secret ? "credential_required" : "host_owned",
          });
      }
    };
    for (const integration of read.integrations) {
      const snapshot = await integrationOwnershipSnapshot(integration.id, read),
        row = read.integrationRows.find((r) => r.integrationId === integration.id),
        config: Record<string, never> = {};
      add("integration", integration.id, snapshot.ownership);
      for (const [key, ownership] of Object.entries(snapshot.ownership))
        if (
          !ownership.secret &&
          ownership.source === "database" &&
          ownership.writable &&
          row &&
          Object.hasOwn(row.config, key)
        )
          config[key] = row.config[key] as never;
      if (Object.keys(config).length)
        document.integrations.push({ integrationId: integration.id, config });
    }
    for (const service of read.services)
      add(
        "service",
        service.manifest.id,
        (await serviceOwnershipSnapshot(service.manifest.id, read, source)).ownership,
      );
    const rows = await db.select().from(systemSettings);
    for (const def of SETTING_DEFS) {
      const row = rows.find((r) => r.key === def.key),
        host = def.env && read.env[def.env] !== undefined;
      const ownership = projectFieldOwnership({
        source: host ? "env" : row ? "database" : "default",
        secret: !!def.secret,
      });
      add("account", "settings", { [def.key]: ownership });
      if (!def.secret && !host && row) {
        if (!matchesDeclaredType(def, row.value)) throw Error("Invalid declared setting");
        document.settings[def.key] = row.value as never;
      }
      if (def.secret)
        document.prerequisites.push({
          scope: "account",
          id: "settings",
          key: def.key,
          source: ownership.source,
          reason: "protected_bootstrap",
        });
    }
    // Portable platform fields contain explicit database values only; host-owned values are never copied.
    if (source.platform) {
      const resolved = services.resolvePlatformConfiguration({
        saved: source.platform,
        env: read.env,
      });
      document.platform = { version: 1 };
      for (const [key, field] of Object.entries(source.platform)) {
        if (key === "version") continue;
        if (
          field &&
          typeof field === "object" &&
          field.source === "database" &&
          resolved.sources[key as keyof typeof resolved.sources] === "database"
        )
          Object.assign(document.platform, { [key]: field });
        else
          document.prerequisites.push({
            scope: "platform",
            id: "platform",
            key,
            source: "env",
            reason: "host_owned",
          });
      }
    }
    return configurationMigrationInventorySchema.parse({ document, fields });
  });
}
