import { describe, expect, it } from "vitest";
import { serviceManifestSchema } from "../manifest-schema";

describe("service manifest gpu field", () => {
  it("accepts an optional container.gpu reservation", () => {
    const manifest = serviceManifestSchema.parse({
      id: "local-ai",
      name: "Local AI",
      version: "1.0.0",
      quality: "built-in",
      container: {
        image: "ollama/ollama",
        tag: "latest",
        expose: [11434],
        gpu: { driver: "nvidia", count: "all", capabilities: ["gpu"] },
      },
    });
    expect(manifest.container.gpu).toEqual({
      driver: "nvidia",
      count: "all",
      capabilities: ["gpu"],
    });
  });

  it("treats gpu as optional", () => {
    const manifest = serviceManifestSchema.parse({
      id: "x",
      name: "X",
      version: "1.0.0",
      quality: "built-in",
      container: { image: "img", tag: "latest" },
    });
    expect(manifest.container.gpu).toBeUndefined();
  });

  it("fills gpu schema defaults for a partial gpu object", () => {
    const manifest = serviceManifestSchema.parse({
      id: "gpu-svc",
      name: "GPU Service",
      version: "1.0.0",
      quality: "built-in",
      container: {
        image: "some/image",
        tag: "latest",
        gpu: { count: 2 },
      },
    });
    expect(manifest.container.gpu).toEqual({
      driver: "nvidia",
      count: 2,
      capabilities: ["gpu"],
    });
  });
});
