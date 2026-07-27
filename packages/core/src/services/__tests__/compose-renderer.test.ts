import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mergeServiceSecretKeys,
  readServiceSecretKeysFromCompose,
  readServiceSecretKeysFromDisk,
  renderCompose,
  renderServiceSnippet,
} from "../compose-renderer";
import type { LoadedService } from "../types";

function makeService(container: LoadedService["manifest"]["container"]): LoadedService {
  return {
    manifest: {
      id: "test-svc",
      name: "Test Service",
      version: "1.0.0",
      quality: "built-in",
      container,
    },
    directory: "/fake/services/test-svc",
    isBuiltIn: true,
    enabled: true,
  };
}

describe("renderServiceSnippet GPU support", () => {
  it("emits deploy.resources.reservations.devices for a container with gpu", () => {
    const service = makeService({
      image: "ollama/ollama",
      tag: "latest",
      memory: "8g",
      gpu: { driver: "nvidia", count: "all", capabilities: ["gpu"] },
    });

    const snippet = renderServiceSnippet(service, { existsSync: () => true });

    expect(snippet.deploy?.resources?.reservations?.devices).toEqual([
      { driver: "nvidia", count: "all", capabilities: ["gpu"] },
    ]);
    expect(snippet.deploy?.resources?.limits?.memory).toBe("8g");
  });

  it("emits only limits when there is no gpu", () => {
    const service = makeService({
      image: "nginx",
      tag: "stable",
      memory: "512m",
    });

    const snippet = renderServiceSnippet(service, { existsSync: () => true });

    expect(snippet.deploy?.resources?.limits?.memory).toBe("512m");
    expect(snippet.deploy?.resources?.reservations).toBeUndefined();
  });

  it("omits deploy entirely when neither memory nor gpu is set", () => {
    const service = makeService({ image: "busybox", tag: "latest" });
    const snippet = renderServiceSnippet(service, { existsSync: () => true });
    expect(snippet.deploy).toBeUndefined();
  });
});

describe("readServiceSecretKeysFromCompose — CLI/admin secrets-block parity", () => {
  let dir: string;
  let composePath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omx-secrets-"));
    composePath = join(dir, "docker-compose.generated.yml");
    writeFileSync(
      composePath,
      [
        "services:",
        "  openconditions-ingest:",
        "    image: x",
        "secrets:",
        "  openconditions-ingest__NH_API_KEY:",
        "    file: ./.generated-secrets/openconditions-ingest/NH_API_KEY",
        "  openconditions-ingest__MOBILITHEK_CERT:",
        "    file: ./.generated-secrets/openconditions-ingest/MOBILITHEK_CERT",
        "  app-api__SOME_KEY:",
        "    file: ./.generated-secrets/app-api/SOME_KEY",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reconstructs per-service secret key names from the compose secrets block (sorted)", () => {
    const map = readServiceSecretKeysFromCompose(composePath);
    expect(map.get("openconditions-ingest")).toEqual(["MOBILITHEK_CERT", "NH_API_KEY"]);
    expect(map.get("app-api")).toEqual(["SOME_KEY"]);
  });

  it("returns an empty map for a missing or secrets-less compose (never throws)", () => {
    expect(readServiceSecretKeysFromCompose(join(dir, "nope.yml")).size).toBe(0);
    const noSecrets = join(dir, "no-secrets.yml");
    writeFileSync(noSecrets, "services:\n  x:\n    image: y\n");
    expect(readServiceSecretKeysFromCompose(noSecrets).size).toBe(0);
  });

  it("wires disk-derived keys into the service's secret mounts + <KEY>_FILE env", () => {
    const service = makeService({ image: "ghcr.io/openconditions/ingest", tag: "latest" });
    const snippet = renderServiceSnippet(service, {
      existsSync: () => true,
      serviceSecretKeys: new Map([["test-svc", ["NH_API_KEY"]]]),
    });
    expect(snippet.secrets).toEqual([{ source: "test-svc__NH_API_KEY", target: "NH_API_KEY" }]);
    expect(snippet.environment?.NH_API_KEY_FILE).toBe("/run/secrets/NH_API_KEY");
  });
});

describe("readServiceSecretKeysFromDisk", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omx-secrets-disk-"));
    const root = join(dir, ".generated-secrets");
    mkdirSync(join(root, "openconditions-ingest"), { recursive: true });
    writeFileSync(join(root, "openconditions-ingest", "NH_API_KEY"), "value-a");
    writeFileSync(join(root, "openconditions-ingest", "MOBILITHEK_CERT"), "value-b");
    // Stray top-level file must be skipped, never crash the scan.
    writeFileSync(join(root, "README"), "not a service dir");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reconstructs per-service key names from the materialised secret files (sorted)", () => {
    const map = readServiceSecretKeysFromDisk(dir);
    expect(map.get("openconditions-ingest")).toEqual(["MOBILITHEK_CERT", "NH_API_KEY"]);
    expect(map.size).toBe(1);
  });

  it("returns an empty map when the .generated-secrets dir is absent (never throws)", () => {
    expect(readServiceSecretKeysFromDisk(join(dir, "nope")).size).toBe(0);
  });
});

describe("mergeServiceSecretKeys", () => {
  it("unions per-service keys across sources, deduplicated and sorted", () => {
    const merged = mergeServiceSecretKeys(
      new Map([["ingest", ["NH_API_KEY", "SE_TRAFIKVERKET_API_KEY"]]]),
      new Map([
        ["ingest", ["NH_API_KEY", "DE_NRW_SUBSCRIPTION_ID"]],
        ["app-api", ["SOME_KEY"]],
      ]),
    );
    expect(merged.get("ingest")).toEqual([
      "DE_NRW_SUBSCRIPTION_ID",
      "NH_API_KEY",
      "SE_TRAFIKVERKET_API_KEY",
    ]);
    expect(merged.get("app-api")).toEqual(["SOME_KEY"]);
  });
});

describe("narrowed render preserves the vault-secret record", () => {
  const keys = new Map([
    ["test-svc", ["NH_API_KEY"]],
    ["openconditions-ingest", ["SE_TRAFIKVERKET_API_KEY"]],
  ]);

  it("keeps top-level secrets entries for services outside the rendered subset", () => {
    // Only test-svc is rendered; openconditions-ingest is excluded (e.g.
    // `compose render --services ...`). Its secret record must survive so the
    // next full render can re-attach the mounts instead of silently dropping
    // the credentials.
    const service = makeService({ image: "t/x", tag: "latest" });
    const { composeYaml } = renderCompose([service], { serviceSecretKeys: keys });
    expect(composeYaml).toContain("test-svc__NH_API_KEY");
    expect(composeYaml).toContain("openconditions-ingest__SE_TRAFIKVERKET_API_KEY");
    expect(composeYaml).toContain(
      "./.generated-secrets/openconditions-ingest/SE_TRAFIKVERKET_API_KEY",
    );
    // The excluded service itself is NOT rendered — only its secret record.
    expect(composeYaml).not.toContain("openconditions-ingest:\n");
  });

  it("round-trips: a later render still recovers the excluded service's keys", () => {
    const service = makeService({ image: "t/x", tag: "latest" });
    const { composeYaml } = renderCompose([service], { serviceSecretKeys: keys });
    const dir = mkdtempSync(join(tmpdir(), "omx-secrets-roundtrip-"));
    try {
      const composePath = join(dir, "docker-compose.generated.yml");
      writeFileSync(composePath, composeYaml);
      const recovered = readServiceSecretKeysFromCompose(composePath);
      expect(recovered.get("test-svc")).toEqual(["NH_API_KEY"]);
      expect(recovered.get("openconditions-ingest")).toEqual(["SE_TRAFIKVERKET_API_KEY"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
