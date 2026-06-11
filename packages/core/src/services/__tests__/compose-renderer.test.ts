import { describe, expect, it } from "vitest";
import { renderServiceSnippet } from "../compose-renderer";
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
