import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readServiceSecretKeysFromDisk, renderServiceSnippet } from "../compose-renderer";
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

describe("readServiceSecretKeysFromDisk — CLI/admin secrets-block parity", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omx-secrets-"));
    const ingest = join(dir, ".generated-secrets", "openconditions-ingest");
    mkdirSync(ingest, { recursive: true });
    writeFileSync(join(ingest, "NH_API_KEY"), "x");
    writeFileSync(join(ingest, "MOBILITHEK_CERT"), "y");
    const api = join(dir, ".generated-secrets", "app-api");
    mkdirSync(api, { recursive: true });
    writeFileSync(join(api, "SOME_KEY"), "z");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reconstructs per-service secret key names from the on-disk files (sorted)", () => {
    const map = readServiceSecretKeysFromDisk(dir);
    expect(map.get("openconditions-ingest")).toEqual(["MOBILITHEK_CERT", "NH_API_KEY"]);
    expect(map.get("app-api")).toEqual(["SOME_KEY"]);
  });

  it("returns an empty map when no secrets have been applied", () => {
    const empty = mkdtempSync(join(tmpdir(), "omx-nosecrets-"));
    try {
      expect(readServiceSecretKeysFromDisk(empty).size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
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
