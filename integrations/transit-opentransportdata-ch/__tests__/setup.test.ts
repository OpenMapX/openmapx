import { readFileSync } from "node:fs";
import type { IntegrationManifest } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";
import { allowQuota } from "./helpers.js";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as IntegrationManifest;
function candidate(key: string, endpoint?: string) {
  const http = fakeHttpClient(() => "<OJP/>");
  const config = { apiKey: key, ...(endpoint ? { ojpEndpoint: endpoint } : {}) };
  const ctx = createMockIntegrationContext({ id: manifest.id, manifest, config, http });
  const shutdown: Array<() => Promise<void>> = [];
  Object.assign(ctx, { upstreamRuntime: allowQuota() });
  ctx.onShutdown = (fn) => {
    shutdown.push(fn);
  };
  ctx.onActivate = vi.fn();
  return {
    ctx,
    config,
    http,
    dispose: async () => {
      await Promise.all(shutdown.map((fn) => fn()));
    },
  };
}

describe("Swiss detached setup", () => {
  it("initializes isolated attribution and configuration before activation", async () => {
    const first = candidate("A");
    setup(first.ctx);
    first.config.apiKey = "B";
    expect(first.ctx.onActivate).not.toHaveBeenCalled();
    expect(first.ctx.registered.transit[0]?.attribution.length).toBeGreaterThan(0);
    expect(await first.ctx.registered.healthChecks[0]?.()).toMatchObject({ status: "up" });
    expect(first.http.calls[0]?.options?.headers?.Authorization).toBe("Bearer A");
    await first.dispose();
  });

  it("rejects invalid candidate endpoints without changing the active generation", async () => {
    const first = candidate("A");
    setup(first.ctx);
    const broken = candidate("B", "http://unsafe.test/ojp");
    expect(() => setup(broken.ctx)).toThrow(/HTTPS/);
    expect(await first.ctx.registered.healthChecks[0]?.()).toMatchObject({ status: "up" });
    expect(first.http.calls[0]?.options?.headers?.Authorization).toBe("Bearer A");
    expect(broken.http.calls).toHaveLength(0);
    await first.dispose();
    await broken.dispose();
  });

  it("retiring A does not retire B", async () => {
    const first = candidate("A");
    const second = candidate("B");
    setup(first.ctx);
    setup(second.ctx);
    await first.dispose();
    expect(await second.ctx.registered.healthChecks[0]?.()).toMatchObject({ status: "up" });
    expect(second.http.calls[0]?.options?.headers?.Authorization).toBe("Bearer B");
    await expect(first.ctx.registered.transit[0]?.getRoute?.("otdch:missing")).rejects.toThrow(
      /retired/,
    );
    await second.dispose();
  });
});
