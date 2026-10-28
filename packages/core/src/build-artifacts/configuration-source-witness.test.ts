import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commitConfigurationGeneration } from "../services/configuration-generation";
import { writeServiceSelectionFile } from "../services/deployment";
import {
  PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV,
  parseReleaseComposeSelection,
  TRANSITOUS_TOOLS_IMAGE_ENV,
} from "../services/release-manifest";
import type { LoadedService } from "../services/types";
import {
  observeConfigurationSources,
  verifyConfigurationSourceWitness,
} from "./configuration-source-witness";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "./control-authority";

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-source-witness-"));
  mkdirSync(join(root, "data"));
  await provisionControlInstallation(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("retains the original private release selection instead of accepting a changed image pin", () => {
  const installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["data-manager"],
  });
  try {
    const pins = Object.fromEntries(
      [
        "api",
        "web",
        "data-manager",
        "ops-agent",
        "transitous-runner",
        "privacy-backup",
        "transitous-tools",
      ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"b".repeat(64)}`]),
    );
    const document = {
      services: {
        "app-api": {
          image: pins.api,
          environment: { [PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV]: pins["privacy-backup"] },
        },
        "app-web": { image: pins.web },
        "data-manager": {
          image: pins["data-manager"],
          environment: { [TRANSITOUS_TOOLS_IMAGE_ENV]: pins["transitous-tools"] },
        },
        "ops-agent": {
          image: pins["ops-agent"],
          environment: { [PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV]: pins["privacy-backup"] },
        },
        "transitous-runner": { image: pins["transitous-runner"] },
      },
      "x-openmapx-release": { release: "public-release-fixture", images: pins },
    };
    const path = join(root, "docker-compose.release.yml");
    writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
    expect(parseReleaseComposeSelection(JSON.stringify(document)).release).toBe(
      "public-release-fixture",
    );
    const options = {
        installation,
        infraDir: root,
        services: [] as LoadedService[],
        authorityRevision: "v1",
        env: {},
      },
      observed = observeConfigurationSources(options),
      verify = () =>
        verifyConfigurationSourceWitness({
          ...options,
          sourceRevision: observed.sourceRevision,
          expectedCurrentRevisionId: null,
        });
    expect(Object.keys(observed).sort()).toEqual(["revisionId", "services", "sourceRevision"]);
    verify();
    pins["data-manager"] = `ghcr.io/openmapx/data-manager@sha256:${"c".repeat(64)}`;
    document.services["data-manager"].image = pins["data-manager"];
    writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
    expect(() => verify()).toThrow("Host sources changed");
  } finally {
    closeControlInstallation(installation);
  }
});
it("keeps host values private while detecting a changed persisted full selection", () => {
  const installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  try {
    writeServiceSelectionFile(root, ["motis"]);
    const options = {
      installation,
      infraDir: root,
      services: [] as LoadedService[],
      authorityRevision: "v1",
      env: {},
    };
    const observed = observeConfigurationSources(options);
    verifyConfigurationSourceWitness({
      ...options,
      sourceRevision: observed.sourceRevision,
      expectedCurrentRevisionId: null,
    });
    writeServiceSelectionFile(root, []);
    expect(() =>
      verifyConfigurationSourceWitness({
        ...options,
        sourceRevision: observed.sourceRevision,
        expectedCurrentRevisionId: null,
      }),
    ).toThrow("Host sources changed");
  } finally {
    closeControlInstallation(installation);
  }
});
it("reports namespaced fields and the actual supported manifest memory token without values", () => {
  const installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  try {
    writeFileSync(join(root, ".env"), "MOTIS_SLOT_MEMORY=8g\nSERVICE_MOTIS_WORKERS=77\n", {
      mode: 0o600,
    });
    const services: LoadedService[] = [
      {
        directory: join(root, "motis"),
        isBuiltIn: true,
        enabled: true,
        manifest: {
          id: "motis",
          name: "MOTIS",
          version: "1.0.0",
          quality: "built-in",
          configSchema: { properties: { WORKERS: { type: "integer" } } },
          container: { image: "fixture/motis", tag: "1", memory: "${MOTIS_SLOT_MEMORY:-4g}" },
        },
      },
    ];
    const observed = observeConfigurationSources({
      installation,
      infraDir: root,
      services,
      authorityRevision: "v1",
      env: {},
    });
    expect(observed.services[0]?.fields).toContainEqual({
      key: "WORKERS",
      source: "host",
      envVar: "SERVICE_MOTIS_WORKERS",
    });
    expect(observed.services[0]?.fields).toContainEqual({
      key: "OPENMAPX_MEMORY_MIB",
      source: "host",
      envVar: "MOTIS_SLOT_MEMORY",
    });
    expect(JSON.stringify(observed)).not.toContain("8g");
    // Match the serialized value, not coincidental bytes inside its random source UUID.
    expect(JSON.stringify(observed)).not.toContain('"77"');
    expect(JSON.stringify(observed)).not.toContain('"value"');
  } finally {
    closeControlInstallation(installation);
  }
});
it("includes declared flat-schema host fields in the same private source witness", () => {
  const installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  try {
    writeFileSync(join(root, ".env"), "SERVICE_MOTIS_WORKERS=77\n", { mode: 0o600 });
    const services: LoadedService[] = [
      {
        directory: join(root, "motis"),
        isBuiltIn: true,
        enabled: true,
        manifest: {
          id: "motis",
          name: "MOTIS",
          version: "1.0.0",
          quality: "built-in",
          configSchema: { WORKERS: { type: "integer" } },
          container: { image: "fixture/motis", tag: "1" },
        },
      },
    ];
    const observed = observeConfigurationSources({
      installation,
      infraDir: root,
      services,
      authorityRevision: "v1",
      env: {},
    });
    expect(observed.services[0]?.fields).toContainEqual({
      key: "WORKERS",
      source: "host",
      envVar: "SERVICE_MOTIS_WORKERS",
    });
    // Match the serialized value, not coincidental bytes inside its random source UUID.
    expect(JSON.stringify(observed)).not.toContain('"77"');
    expect(JSON.stringify(observed)).not.toContain('"value"');
  } finally {
    closeControlInstallation(installation);
  }
});

it("projects only validated non-secret platform ownership under the original revision witness", async () => {
  const installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: [],
  });
  try {
    const platform = {
      version: 1 as const,
      domain: { source: "database" as const, value: "adopted.example.test" },
    };
    const applied = await commitConfigurationGeneration({
      infraDir: root,
      services: [],
      input: {
        domain: "adopted.example.test",
        platform,
        selectedRoots: [],
        serviceConfigs: [],
        serviceSecrets: [],
        integrationConfigs: [],
      },
    });
    const options = {
      installation,
      infraDir: root,
      services: [] as LoadedService[],
      authorityRevision: "v1",
      env: { BETTER_AUTH_SECRET: "not-public" },
    };
    const observed = observeConfigurationSources(options);
    expect(observed.platform).toEqual(platform);
    expect(JSON.stringify(observed)).not.toContain("not-public");
    verifyConfigurationSourceWitness({
      ...options,
      sourceRevision: observed.sourceRevision,
      expectedCurrentRevisionId: applied.revisionId,
    });
  } finally {
    closeControlInstallation(installation);
  }
});
