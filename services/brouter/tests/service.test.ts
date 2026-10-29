import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderServiceSnippet } from "../../../packages/core/src/services/compose-renderer";
import {
  flattenResolvedConfig,
  resolveServiceConfigFromEnv,
} from "../../../packages/core/src/services/config-resolver";
import { validateServiceManifest } from "../../../packages/core/src/services/manifest-schema";
import { DEFAULT_SELECTED_SERVICE_IDS } from "../../../packages/core/src/services/selection";
import type { ServiceManifest } from "../../../packages/core/src/services/types";

describe("optional managed BRouter service", () => {
  it("validates and renders with standard region settings, private ports and persistent data", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../service.json", import.meta.url), "utf8"),
    ) as ServiceManifest;
    expect(validateServiceManifest(manifest, { firstParty: true }).valid).toBe(true);
    expect(DEFAULT_SELECTED_SERVICE_IDS).not.toContain("brouter");
    const config = flattenResolvedConfig(
      resolveServiceConfigFromEnv(manifest, {
        SERVICE_BROUTER_REGION: "planet",
        SERVICE_BROUTER_MAXTHREADS: "4",
      }),
    );
    expect(config.REGION).toBe("planet");
    expect(config.MAXTHREADS).toBe("4");
    const snippet = renderServiceSnippet(
      { manifest, directory: "/repo/services/brouter", isBuiltIn: true, enabled: true },
      {
        existsSync: () => true,
        resolvedServiceConfigs: new Map([["brouter", config]]),
      },
    );
    expect(snippet.environment?.REGION).toBe("planet");
    expect(snippet.image).toContain("@sha256:");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose substitution
    expect(snippet.ports).toEqual(["127.0.0.1:${BROUTER_HOST_PORT:-17777}:17777"]);
    expect(manifest.volumes).toContainEqual({
      name: "openmapx-brouter",
      mountAt: "/data/brouter",
      backup: false,
    });
    expect(manifest.exposure?.proxy).toBeUndefined();
    expect(manifest.container.healthcheck?.command).toEqual([
      "bash",
      "/opt/openmapx/brouter/run.sh",
      "health",
    ]);
  });
});
