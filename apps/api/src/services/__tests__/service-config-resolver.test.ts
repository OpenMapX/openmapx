import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the DB module before importing the resolver so the real postgres
// connection is never touched. Each test overrides what the mocked chain
// returns.
const selectLimitMock = vi.fn();

vi.mock("../../db", () => {
  const where = vi.fn().mockImplementation(() => ({ limit: selectLimitMock }));
  const from = vi.fn().mockImplementation(() => ({ where }));
  const select = vi.fn().mockImplementation(() => ({ from }));
  return { db: { select } };
});

vi.mock("../../db/schema", () => ({
  serviceConfig: {
    config: "config",
    serviceId: "service_id",
  },
}));

// Import AFTER the mocks are registered.
import { resolveServiceConfigWithSources } from "../service-config-resolver";

afterEach(() => {
  selectLimitMock.mockReset();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SERVICE_TEST_")) delete process.env[key];
  }
});

describe("resolveServiceConfigWithSources", () => {
  const schema = {
    properties: {
      memory_limit: { type: "string", default: "1g" },
      workers: { type: "number", default: 4 },
      no_default: { type: "string" },
    },
  };

  it("returns defaults when no DB row and no env override", async () => {
    selectLimitMock.mockResolvedValueOnce([]);
    const r = await resolveServiceConfigWithSources({ id: "test", configSchema: schema });
    expect(r.memory_limit).toEqual({ value: "1g", source: "default" });
    expect(r.workers).toEqual({ value: 4, source: "default" });
    // no_default has no default and no override — omitted.
    expect(r.no_default).toBeUndefined();
  });

  it("overlays DB values on top of defaults", async () => {
    selectLimitMock.mockResolvedValueOnce([{ config: { memory_limit: "2g" } }]);
    const r = await resolveServiceConfigWithSources({ id: "test", configSchema: schema });
    expect(r.memory_limit).toEqual({ value: "2g", source: "database" });
    expect(r.workers).toEqual({ value: 4, source: "default" });
  });

  it("env vars override DB values (highest priority)", async () => {
    selectLimitMock.mockResolvedValueOnce([{ config: { memory_limit: "2g" } }]);
    process.env.SERVICE_TEST_MEMORY_LIMIT = "8g";
    const r = await resolveServiceConfigWithSources({ id: "test", configSchema: schema });
    expect(r.memory_limit).toEqual({ value: "8g", source: "env" });
  });

  it("ignores DB keys not declared in the configSchema", async () => {
    selectLimitMock.mockResolvedValueOnce([{ config: { unknown_key: "x", memory_limit: "2g" } }]);
    const r = await resolveServiceConfigWithSources({ id: "test", configSchema: schema });
    expect(r.unknown_key).toBeUndefined();
    expect(r.memory_limit).toEqual({ value: "2g", source: "database" });
  });

  it("falls back to defaults when DB query throws", async () => {
    selectLimitMock.mockRejectedValueOnce(new Error("pg unreachable"));
    const r = await resolveServiceConfigWithSources({ id: "test", configSchema: schema });
    expect(r.memory_limit).toEqual({ value: "1g", source: "default" });
  });

  it("returns {} for a service with no configSchema", async () => {
    const r = await resolveServiceConfigWithSources({ id: "test" });
    expect(r).toEqual({});
  });
});
