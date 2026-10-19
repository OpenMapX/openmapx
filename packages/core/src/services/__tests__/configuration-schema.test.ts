import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertTrustedConfigurationSchema,
  validateTrustedConfigurationValues,
} from "../configuration-schema";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");

function manifests(
  base: "integrations" | "services",
): Array<{ path: string; schema?: Record<string, unknown> }> {
  return readdirSync(join(repositoryRoot, base), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .flatMap((entry) => {
      const path = join(
        repositoryRoot,
        base,
        entry.name,
        base === "integrations" ? "manifest.json" : "service.json",
      );
      try {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as {
          configSchema?: Record<string, unknown>;
        };
        return [{ path, schema: manifest.configSchema }];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
}

describe("ops-agent trusted configuration schema", () => {
  it("supports every checked-in service and integration config schema", () => {
    const checkedIn = [...manifests("services"), ...manifests("integrations")];
    expect(checkedIn.length).toBeGreaterThan(100);
    for (const item of checkedIn) {
      expect(() => assertTrustedConfigurationSchema(item.schema), item.path).not.toThrow();
    }
  });

  it.each(["geocoding-entur", "transit-entur"])(
    "trusts %s country schema and validates exact lowercase ISO2 or explicit empty",
    (id) => {
      const manifest = JSON.parse(
        readFileSync(join(repositoryRoot, "integrations", id, "manifest.json"), "utf8"),
      ) as { configSchema: Record<string, unknown> };
      expect(() => assertTrustedConfigurationSchema(manifest.configSchema)).not.toThrow();
      for (const boundaryCountry of ["", "no", "de"]) {
        expect(
          validateTrustedConfigurationValues({ boundaryCountry }, manifest.configSchema),
          JSON.stringify(boundaryCountry),
        ).toBe(true);
      }
      for (const boundaryCountry of [
        "n",
        "nor",
        "NOR",
        "NO",
        " no",
        "no ",
        "  ",
        "nö",
        1,
        null,
        false,
        [],
        {},
      ]) {
        expect(
          validateTrustedConfigurationValues({ boundaryCountry }, manifest.configSchema),
          JSON.stringify(boundaryCountry),
        ).toBe(false);
      }
    },
  );

  it("validates canonical hyphenated values against their shipped schemas", () => {
    const openTransportData = JSON.parse(
      readFileSync(
        join(repositoryRoot, "integrations/transit-opentransportdata-ch/manifest.json"),
        "utf8",
      ),
    ) as { configSchema: Record<string, unknown> };
    const valhalla = JSON.parse(
      readFileSync(join(repositoryRoot, "integrations/routing-valhalla/manifest.json"), "utf8"),
    ) as { configSchema: Record<string, unknown> };

    expect(
      validateTrustedConfigurationValues(
        { requestorRef: "maps.example.test" },
        openTransportData.configSchema,
      ),
    ).toBe(true);
    expect(
      validateTrustedConfigurationValues(
        { "bidirectional-alternates": true },
        valhalla.configSchema,
      ),
    ).toBe(true);
  });
});
