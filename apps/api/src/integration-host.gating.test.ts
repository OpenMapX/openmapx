/**
 * Gating tests for integration-host.ts — the enable/disable semantics
 * (`config.enabled`, `isEnabledIntegrationScheme`, `getIntegrationsByDomain`
 * exclusion) and the injected disallowed-source / disallowed-integration
 * resolvers exposed through the IntegrationContext.
 *
 * These live in a separate file (with their own fixture set and fresh
 * module-level resolver state) because the resolvers are module-level singletons
 * and the main characterization suite is extended by concurrent work — a
 * separate file keeps both changes conflict-free.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationHostTestApp as makeApp } from "./__tests__/support/integration-host-environment.js";

// The fixtures directory that contains our gating test integrations.
const FIXTURES_DIR = join(
  fileURLToPath(import.meta.url),
  "../__tests__/fixtures/integrations-gating",
);

import {
  getAllIntegrations,
  getIntegration,
  getIntegrationsByDomain,
  initIntegrations,
  isEnabledIntegrationScheme,
  isIntegrationScheme,
  reloadIntegrations,
  setDisallowedIntegrationResolver,
  setDisallowedSourceResolver,
  shutdownIntegrations,
} from "./integration-host.js";
import { isSecretsConfigured } from "./services/secrets.js";

afterEach(async () => {
  try {
    await shutdownIntegrations();
  } catch {
    // no-op if never initialized
  }
  delete process.env.INTEGRATION_GAMMA_ENABLED;
  vi.clearAllMocks();
  vi.mocked(isSecretsConfigured).mockReturnValue(true);
});

describe("integration-host — disallowed resolvers via ctx", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);
  });

  // Runs FIRST: module-level resolvers have no unset API, so the default-empty
  // behavior can only be observed before any test injects a resolver.
  it("returns empty disallowed sets when no resolver is injected", async () => {
    const res = await app.inject({ method: "GET", url: "/api/integrations/delta/disallowed" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sources: [], integrations: [] });
  });

  it("surfaces injected resolver results through the ctx getters", async () => {
    setDisallowedSourceResolver(async () => new Set(["osm-gated"]));
    setDisallowedIntegrationResolver(async () => new Set(["gamma"]));
    const res = await app.inject({ method: "GET", url: "/api/integrations/delta/disallowed" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sources: ["osm-gated"], integrations: ["gamma"] });
  });
});

describe("integration-host — config.enabled gating", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);
  });

  it("registers a config-disabled integration but marks it inert", () => {
    expect(getIntegration("gamma")?.enabled).toBe(false);
    // Disabled ≠ removed: the registry still lists it.
    expect(getAllIntegrations().map((i) => i.id)).toContain("gamma");
    expect(isIntegrationScheme("gamma")).toBe(true);
    expect(isEnabledIntegrationScheme("gamma")).toBe(false);
    const knowledge = getIntegrationsByDomain("knowledge").map((i) => i.id);
    expect(knowledge).toContain("delta");
    expect(knowledge).not.toContain("gamma");
  });

  it("does not register routes for a disabled integration while dispatch stays live", async () => {
    const live = await app.inject({ method: "GET", url: "/api/integrations/delta/disallowed" });
    expect(live.statusCode).toBe(200);
    const disabled = await app.inject({ method: "GET", url: "/api/integrations/gamma/ping" });
    expect(disabled.statusCode).toBe(404);
  });

  it("enables the integration when the env flag flips on reload", async () => {
    expect(getIntegration("gamma")?.enabled).toBe(false);
    process.env.INTEGRATION_GAMMA_ENABLED = "true";
    await reloadIntegrations();
    expect(getIntegration("gamma")?.enabled).toBe(true);
    expect(isEnabledIntegrationScheme("gamma")).toBe(true);
    expect(getIntegrationsByDomain("knowledge").map((i) => i.id)).toContain("gamma");
  });
});
