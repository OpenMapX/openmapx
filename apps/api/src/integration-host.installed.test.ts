/**
 * Installed (non-built-in) integrations with and without an operations agent.
 * With an agent, only integrations it reports intact are loaded, and every
 * file read from them must match the digest the agent recorded. Without one
 * (host development), the directory is scanned as it is.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationHostTestApp as makeApp } from "./__tests__/support/integration-host-environment.js";
import {
  type AgentInstalledIntegration,
  getIntegration,
  initIntegrations,
  reloadIntegrations,
  setInstalledIntegrationResolver,
  shutdownIntegrations,
} from "./integration-host.js";

const MANIFEST = {
  id: "delta",
  version: "1.0.0",
  author: "Test",
  license: "MIT",
  domains: ["knowledge"],
  quality: "community",
  configSchema: {
    properties: { greeting: { type: "string", default: "from-default" } },
  },
  frontend: {
    mapLayer: false,
    legend: false,
    panel: false,
    layerSelector: { group: "map-details", labelKey: "delta", preview: "preview.svg" },
  },
};
const PREVIEW = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

let root: string;
let directory: string;

function write(path: string, content: string): void {
  mkdirSync(join(directory, path, ".."), { recursive: true });
  writeFileSync(join(directory, path), content);
}

/** What the agent would report for the files currently in the integration directory. */
function recordedFiles(): Array<{ path: string; sha256: string }> {
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = (relativeDirectory: string) => {
    for (const entry of readdirSync(join(directory, relativeDirectory), { withFileTypes: true })) {
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else
        files.push({
          path,
          sha256: createHash("sha256")
            .update(readFileSync(join(directory, path)))
            .digest("hex"),
        });
    }
  };
  visit("");
  return files;
}

function agentReports(installed: AgentInstalledIntegration[] | null) {
  const resolver = vi.fn(async () => installed);
  setInstalledIntegrationResolver(resolver);
  return resolver;
}

async function start() {
  const app = makeApp();
  await initIntegrations(app, [{ directory: root, isBuiltIn: false }]);
  return app;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-installed-integrations-"));
  directory = join(root, "delta");
  write("manifest.json", JSON.stringify(MANIFEST));
  write("strings/en.json", JSON.stringify({ title: "Delta" }));
  write("strings/de.json", JSON.stringify({ title: "Delta (de)" }));
  write("preview.svg", PREVIEW);
  write("config.json", JSON.stringify({ greeting: "from-config-json" }));
});

afterEach(async () => {
  setInstalledIntegrationResolver(null);
  await shutdownIntegrations().catch(() => {});
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("installed integrations without an operations agent", () => {
  it.each([
    ["no resolver", () => setInstalledIntegrationResolver(null)],
    ["a resolver that reports no agent", () => agentReports(null)],
  ])("scans the directory as it is (%s)", async (_label, setup) => {
    setup();
    // Files nothing recorded are read as they are.
    write("strings/fr.json", JSON.stringify({ title: "Delta (fr)" }));
    const app = await start();

    const delta = getIntegration("delta");
    expect(delta).toMatchObject({ isBuiltIn: false });
    expect(Object.keys(delta?.strings ?? {}).sort()).toEqual(["de", "en", "fr"]);
    expect(delta?.config.greeting).toBe("from-config-json");
    const preview = await app.inject({ method: "GET", url: "/api/integrations/delta/preview" });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toBe(PREVIEW);
  });
});

describe("installed integrations with an operations agent", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("loads an integration the agent reports intact and reads its recorded files", async () => {
    const resolver = agentReports([{ integrationId: "delta", files: recordedFiles() }]);
    const app = await start();

    const delta = getIntegration("delta");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(delta?.directory).toBe(directory);
    expect(Object.keys(delta?.strings ?? {}).sort()).toEqual(["de", "en"]);
    expect(delta?.config.greeting).toBe("from-config-json");
    const preview = await app.inject({ method: "GET", url: "/api/integrations/delta/preview" });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toBe(PREVIEW);
  });

  it("does not load a directory the agent does not report", async () => {
    agentReports([]);
    await start();
    expect(getIntegration("delta")).toBeUndefined();
  });

  it("loads none of them when the installed list is unavailable", async () => {
    setInstalledIntegrationResolver(async () => {
      throw new Error("agent unavailable");
    });
    await start();
    expect(getIntegration("delta")).toBeUndefined();
  });

  it("skips an integration whose manifest changed since the agent installed it", async () => {
    const files = recordedFiles();
    write("manifest.json", JSON.stringify({ ...MANIFEST, version: "6.6.6" }));
    agentReports([{ integrationId: "delta", files }]);

    await start();

    expect(getIntegration("delta")).toBeUndefined();
  });

  it("ignores strings, preview and config files that changed or were never installed", async () => {
    const files = recordedFiles().filter((file) => file.path !== "config.json");
    write("strings/de.json", JSON.stringify({ title: "tampered" }));
    write("strings/fr.json", JSON.stringify({ title: "unlisted" }));
    write("preview.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    agentReports([{ integrationId: "delta", files }]);

    const app = await start();

    const delta = getIntegration("delta");
    expect(Object.keys(delta?.strings ?? {})).toEqual(["en"]);
    expect(delta?.config.greeting).toBe("from-default");
    const preview = await app.inject({ method: "GET", url: "/api/integrations/delta/preview" });
    expect(preview.statusCode).toBe(404);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("strings/de.json in"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("strings/fr.json in"));
  });

  it("asks the agent again on every reload", async () => {
    const resolver = agentReports([{ integrationId: "delta", files: recordedFiles() }]);
    await start();
    expect(getIntegration("delta")).toBeDefined();

    resolver.mockResolvedValue([]);
    await reloadIntegrations();

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(getIntegration("delta")).toBeUndefined();
  });
});
