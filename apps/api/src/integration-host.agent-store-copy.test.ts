/**
 * An integration an earlier release's agent installed in the checkout, copied
 * into the agent's state, loaded by app-api from that directory (its mount
 * after the update) by the digests the agent reports, then removed there.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { packageIntegration } from "@openmapx/integration-framework/installer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntegrationStore } from "../../ops-agent/src/integration-store";
import { createIntegrationHostTestApp as makeApp } from "./__tests__/support/integration-host-environment.js";
import {
  getIntegration,
  initIntegrations,
  reloadIntegrations,
  setInstalledIntegrationResolver,
  shutdownIntegrations,
} from "./integration-host.js";

const uid = process.geteuid?.() ?? 0;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let root: string;
const scratch: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-api-agent-stores-"));
  chmodSync(root, 0o755);
  // The copy runs from a checkout, which the agent has mounted whole.
  mkdirSync(join(root, "services"));
  mkdirSync(services.agentStatePaths(join(root, "infra", "docker")).directory, {
    recursive: true,
    mode: 0o700,
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  setInstalledIntegrationResolver(null);
  await shutdownIntegrations().catch(() => {});
  for (const path of [root, ...scratch.splice(0)]) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("loads an integration copied from the checkout out of the agent's store, until it is removed there", async () => {
  // The archive an extension installs.
  const source = mkdtempSync(join(tmpdir(), "openmapx-api-integration-source-"));
  scratch.push(source);
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({
      id: "weather-radar",
      name: "Weather radar",
      version: "1.0.0",
      domains: ["map-overlay"],
      quality: "community",
      platform: "1.0",
      configSchema: { type: "object", properties: { region: { enum: ["eu"] } } },
    }),
  );
  const archive = join(source, "..", `weather-radar-${Math.random()}.tar.gz`);
  scratch.push(archive);
  await packageIntegration({ rootDir: root, source, outFile: archive });
  const url = "https://artifacts.example.test/weather-radar.tar.gz";
  const store = (directory?: string) =>
    new IntegrationStore({
      rootDir: root,
      ...(directory ? { directory } : {}),
      uid,
      builtInIds: () => new Set(),
      download: async ({ destination }) => copyFileSync(archive, destination),
    });

  // Installed by an earlier release, in the checkout.
  const infraDir = join(root, "infra", "docker");
  const earlier = store(services.legacyAgentStorePaths(infraDir).customIntegrations);
  const published = await earlier.publish(
    {
      kind: "integration.publish",
      integrationId: "weather-radar",
      source: { kind: "artifact", url, sha256: sha256(readFileSync(archive)) },
    },
    new AbortController().signal,
  );
  await earlier.settle({
    kind: "integration.settle",
    integrationId: "weather-radar",
    transactionId: published.transactionId,
    outcome: "commit",
  });

  expect(services.prepareAgentStores(infraDir, { uid })?.integrations.copied).toEqual([
    "weather-radar",
  ]);

  // app-api: the store is its mount; the agent reports what it holds.
  const agent = store();
  setInstalledIntegrationResolver(async () =>
    (await agent.list()).integrations
      .filter((entry) => entry.status === "ok")
      .map((entry) => ({ integrationId: entry.integrationId, files: entry.files })),
  );
  const mount = services.agentStatePaths(infraDir).customIntegrations;
  await initIntegrations(makeApp(), [{ directory: mount, isBuiltIn: false }]);
  expect(getIntegration("weather-radar")).toMatchObject({
    isBuiltIn: false,
    directory: join(mount, "weather-radar"),
  });

  await agent.remove({ kind: "integration.remove", integrationId: "weather-radar" });
  await reloadIntegrations();
  expect(getIntegration("weather-radar")).toBeUndefined();
});
