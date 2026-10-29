import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  stop: vi.fn(),
  end: vi.fn(),
  unsafe: vi.fn(),
  construct: vi.fn(),
  drizzle: vi.fn(),
}));
vi.mock("@testcontainers/postgresql", () => ({
  PostgreSqlContainer: class {
    withDatabase() {
      return this;
    }
    withUsername() {
      return this;
    }
    withPassword() {
      return this;
    }
    withStartupTimeout() {
      return this;
    }
    async start() {
      return { getConnectionUri: () => "postgres://disposable", stop: mock.stop };
    }
  },
}));
vi.mock("postgres", () => ({ default: mock.construct }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mock.drizzle }));

import { startPostgis } from "./postgis-testcontainer";

describe("disposable PostGIS fixture ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.construct.mockReturnValue({ unsafe: mock.unsafe, end: mock.end });
    mock.stop.mockResolvedValue(undefined);
    mock.end.mockResolvedValue(undefined);
    mock.unsafe.mockResolvedValue([]);
  });
  it("closes the owned container after extension setup failure and preserves that error", async () => {
    const original = new Error("extension failed");
    mock.unsafe.mockRejectedValue(original);
    mock.end.mockRejectedValue(new Error("pool close failed"));
    await expect(startPostgis()).rejects.toMatchObject({
      cause: original,
      errors: [original, expect.any(AggregateError)],
    });
    expect(mock.end).toHaveBeenCalledWith({ timeout: 2 });
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it("stops the container when client construction fails", async () => {
    const original = new Error("client construction failed");
    mock.construct.mockImplementation(() => {
      throw original;
    });
    await expect(startPostgis()).rejects.toBe(original);
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it("attempts both shutdown steps and reports every rejection", async () => {
    const fixture = await startPostgis();
    const pool = new Error("pool failed"),
      container = new Error("container failed");
    mock.end.mockRejectedValue(pool);
    mock.stop.mockRejectedValue(container);
    await expect(fixture.stop()).rejects.toMatchObject({ errors: [pool, container] });
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it("retains client configuration, serializer setup and successful shutdown", async () => {
    const fixture = await startPostgis();
    expect(mock.construct).toHaveBeenCalledWith("postgres://disposable", { max: 2 });
    expect(mock.drizzle).toHaveBeenCalledWith(fixture.sql);
    expect(mock.unsafe).toHaveBeenCalledWith("CREATE EXTENSION IF NOT EXISTS postgis");
    await fixture.stop();
    expect(mock.end).toHaveBeenCalledOnce();
    expect(mock.stop).toHaveBeenCalledOnce();
  });
});
