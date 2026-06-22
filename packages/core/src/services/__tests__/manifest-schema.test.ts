import { describe, expect, it } from "vitest";
import { serviceManifestSchema, validateServiceManifest } from "../manifest-schema";

const minimalManifest = {
  id: "conditions-ingest",
  name: "Conditions Ingest",
  version: "1.0.0",
  quality: "community" as const,
  container: { image: "ghcr.io/openconditions/ingest", tag: "latest" },
};

describe("service manifest ownsSchema field", () => {
  it("accepts a valid ownsSchema identifier", () => {
    const result = validateServiceManifest({ ...minimalManifest, ownsSchema: "conditions" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects an ownsSchema with uppercase letters or spaces", () => {
    const result = validateServiceManifest({ ...minimalManifest, ownsSchema: "Bad Name" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Postgres identifier"))).toBe(true);
  });

  it("validates a manifest without ownsSchema (backward compatibility)", () => {
    const result = validateServiceManifest({ ...minimalManifest });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

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
