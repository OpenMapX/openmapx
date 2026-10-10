import { describe, expect, it } from "vitest";
import { renderCompose, renderServiceSnippet } from "../compose-renderer";
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
  it("renders a readable tag plus the immutable manifest digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const service = makeService({
      image: "vendor/image",
      tag: "1.2.3",
      digest,
    });

    const snippet = renderServiceSnippet(service, { existsSync: () => true });

    expect(snippet.image).toBe(`vendor/image:1.2.3@${digest}`);
  });

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

describe("service secret mounts", () => {
  it("wires secret keys into the service's secret mounts + <KEY>_FILE env", () => {
    const service = makeService({ image: "ghcr.io/openconditions/ingest", tag: "latest" });
    const snippet = renderServiceSnippet(service, {
      existsSync: () => true,
      serviceSecretKeys: new Map([["test-svc", ["NH_API_KEY"]]]),
    });
    expect(snippet.secrets).toEqual([{ source: "test-svc__NH_API_KEY", target: "NH_API_KEY" }]);
    expect(snippet.environment?.NH_API_KEY_FILE).toBe("/run/secrets/NH_API_KEY");
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
});
