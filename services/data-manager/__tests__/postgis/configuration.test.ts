import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { renderServiceSnippet } from "../../../../packages/core/src/services/compose-renderer";
import {
  flattenResolvedConfig,
  resolveServiceConfigFromEnv,
} from "../../../../packages/core/src/services/config-resolver";

const directory = resolve(import.meta.dirname, "../../../postgis");
const manifest = JSON.parse(readFileSync(resolve(directory, "service.json"), "utf8"));
it("renders the opt-in flag from manifest defaults and operator configuration", () => {
  const service = { manifest, directory, isBuiltIn: true, enabled: true };
  for (const enabled of [false, true]) {
    const config = flattenResolvedConfig(
      resolveServiceConfigFromEnv(
        manifest,
        enabled ? { SERVICE_POSTGIS_PG_STAT_STATEMENTS: "true" } : {},
      ),
    );
    const rendered = renderServiceSnippet(service, {
      existsSync: () => true,
      resolvedServiceConfigs: new Map([[manifest.id, config]]),
    });
    expect(rendered.environment?.PG_STAT_STATEMENTS).toBe(String(enabled));
    expect(rendered.command).toEqual(["postgres"]);
    expect(rendered.deploy?.resources?.limits?.memory).toBe("2g");
  }
});
