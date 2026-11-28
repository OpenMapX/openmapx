import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = {
  reloadIntegrations: vi.fn(async () => ({ message: "", reloaded: 0, enabled: 0 })),
  integrationName: vi.fn((_id: string): string | undefined => undefined),
  reloadFailed: vi.fn((_message: string) => {}),
};

const attention = vi.hoisted(() => ({
  raiseAttention: vi.fn(async () => "inserted"),
  resolveAttention: vi.fn(async () => {}),
}));
vi.mock("../services/attention.js", () => attention);

import {
  apiRuntimeDirectory,
  beginBoot,
  getSafeMode,
  initSafeMode,
  isSafeModeActive,
  leaveSafeMode,
  markIntegrationLoading,
  readSafeMode,
  SafeModeForcedError,
  setSafeModeHost,
  syncSafeModeAttention,
} from "../safe-mode.js";

let runtimeDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "omx-safe-mode-"));
  setSafeModeHost({
    reload: () => host.reloadIntegrations(),
    integrationName: (id) => host.integrationName(id),
    reloadFailed: (message) => host.reloadFailed(message),
  });
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
  initSafeMode({}, runtimeDir);
  vi.clearAllMocks();
});

describe("readSafeMode", () => {
  it.each([
    [{ OPENMAPX_SAFE_MODE: "1" }, null, { active: true, reason: "env", integrationId: null }],
    [{}, '{"mode":"operator"}', { active: true, reason: "operator", integrationId: null }],
    [
      {},
      '{"mode":"automatic","integrationId":"acme"}',
      { active: true, reason: "automatic", integrationId: "acme" },
    ],
    [
      {},
      '{"mode":"automatic","integrationId":null}',
      { active: true, reason: "automatic", integrationId: null },
    ],
    [{}, "not json", { active: true, reason: "operator", integrationId: null }],
    [{ OPENMAPX_SAFE_MODE: "0" }, null, { active: false, reason: null, integrationId: null }],
  ])("reads %j with file %j", (env, file, expected) => {
    if (file !== null) writeFileSync(join(runtimeDir, "safe-mode.json"), file);
    expect(readSafeMode(env, runtimeDir)).toEqual(expected);
  });

  it.each([
    ['{"mode":"automatic"}'],
    ['{"mode":"automatic","integrationId":42}'],
    ['{"mode":"automatic","integrationId":""}'],
    ['{"mode":"automatic","integrationId":"Not An Id"}'],
    ['{"mode":"other"}'],
    ["null"],
    ["[]"],
  ])("counts the malformed file %s as the operator's", (file) => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), file);
    expect(readSafeMode({}, runtimeDir)).toEqual({
      active: true,
      reason: "operator",
      integrationId: null,
    });
  });

  it.skipIf(process.getuid?.() === 0)("counts an unreadable file as the operator's", () => {
    const path = join(runtimeDir, "safe-mode.json");
    writeFileSync(path, '{"mode":"automatic","integrationId":"acme"}');
    chmodSync(path, 0o000);
    expect(readSafeMode({}, runtimeDir)).toEqual({
      active: true,
      reason: "operator",
      integrationId: null,
    });
  });

  it("lets the environment win over the file", () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"automatic","integrationId":"a"}');
    expect(readSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir).reason).toBe("env");
  });

  it("is off without the variable and without the file", () => {
    expect(readSafeMode({}, join(runtimeDir, "missing"))).toEqual({
      active: false,
      reason: null,
      integrationId: null,
    });
  });
});

describe("apiRuntimeDirectory", () => {
  it("uses the configured directory", () => {
    expect(apiRuntimeDirectory({ OPENMAPX_API_RUNTIME_DIR: "/srv/runtime" })).toBe("/srv/runtime");
  });

  it("uses the container's directory in production", () => {
    expect(apiRuntimeDirectory({ NODE_ENV: "production" })).toBe("/var/lib/openmapx/runtime");
  });

  it("keeps host development's files in the checkout, not in the shared temporary directory", () => {
    const repository = join(import.meta.dirname, "..", "..", "..", "..");
    const directory = apiRuntimeDirectory({});
    expect(directory).toBe(join(repository, "infra", "docker", "state", "api-runtime"));
    for (const temporary of [tmpdir(), realpathSync(tmpdir())])
      expect(directory.startsWith(`${temporary}${sep}`)).toBe(false);
  });

  it("is ignored in development checkouts by git and by the Docker context", () => {
    const repository = join(import.meta.dirname, "..", "..", "..", "..");
    for (const file of [".gitignore", ".dockerignore"])
      expect(readFileSync(join(repository, file), "utf8").split("\n")).toContain(
        "infra/docker/state/",
      );
  });

  it("is the directory the api service mounts read-write from the host and the image creates", () => {
    const repository = join(import.meta.dirname, "..", "..", "..", "..");
    const manifest = JSON.parse(
      readFileSync(join(repository, "services", "api", "service.json"), "utf8"),
    ) as {
      container: { environment: Record<string, string> };
      bindMounts: Array<{ source: string; target: string; readOnly?: boolean }>;
    };
    const target = manifest.container.environment.OPENMAPX_API_RUNTIME_DIR;
    expect(target).toBe("/var/lib/openmapx/runtime");
    expect(apiRuntimeDirectory({ ...manifest.container.environment, NODE_ENV: "production" })).toBe(
      target,
    );
    expect(manifest.bindMounts).toContainEqual({
      source: "@infra:data/api-runtime",
      target,
      readOnly: false,
    });
    expect(manifest.container.environment.OPENMAPX_SAFE_MODE).toBe("${OPENMAPX_SAFE_MODE:-}");
    expect(readFileSync(join(repository, "apps", "api", "Dockerfile"), "utf8")).toMatch(
      /RUN mkdir -p [^&]*\/var\/lib\/openmapx\/runtime /,
    );
  });
});

describe("the process's safe mode", () => {
  it("is set at boot and read back", () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    expect(initSafeMode({}, runtimeDir)).toEqual({
      active: true,
      reason: "operator",
      integrationId: null,
    });
    expect(getSafeMode()).toEqual({ active: true, reason: "operator", integrationId: null });
    expect(isSafeModeActive()).toBe(true);
  });

  it("ignores the file in a runtime directory the boot refused", () => {
    const target = join(runtimeDir, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "safe-mode.json"), '{"mode":"operator"}');
    const link = join(runtimeDir, "link");
    symlinkSync(target, link);
    beginBoot(link, new Date());
    expect(initSafeMode({}, link)).toEqual({ active: false, reason: null, integrationId: null });
    expect(initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, link)).toEqual({
      active: true,
      reason: "env",
      integrationId: null,
    });
    expect(initSafeMode({}, target).reason).toBe("operator");
  });

  it("is not changed by the file after boot", () => {
    initSafeMode({}, runtimeDir);
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    expect(isSafeModeActive()).toBe(false);
  });
});

describe("leaveSafeMode", () => {
  it("removes the file, forgets the unclean exits, resolves the item and reloads", async () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"automatic","integrationId":"a"}');
    const marker = {
      version: 1,
      running: true,
      installedCodeStarted: true,
      current: null,
      lastFatal: { integrationId: "a", at: "2026-11-27T10:00:00.000Z" },
      uncleanExits: [
        { at: "2026-11-27T09:58:00.000Z", integrationId: "a" },
        { at: "2026-11-27T09:59:00.000Z", integrationId: "a" },
      ],
    };
    writeFileSync(join(runtimeDir, "boot-marker.json"), JSON.stringify(marker));
    initSafeMode({}, runtimeDir);
    host.reloadIntegrations.mockImplementationOnce(async () => {
      expect(isSafeModeActive()).toBe(false);
      return { message: "", reloaded: 0, enabled: 0 };
    });

    await expect(leaveSafeMode()).resolves.toEqual({
      active: false,
      reason: null,
      integrationId: null,
    });

    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(runtimeDir, "boot-marker.json"), "utf8"))).toEqual({
      ...marker,
      uncleanExits: [],
    });
    expect(attention.resolveAttention).toHaveBeenCalledWith("safe-mode");
    expect(host.reloadIntegrations).toHaveBeenCalledTimes(1);
    expect(isSafeModeActive()).toBe(false);
  });

  it("marks what safe mode held back as failed when the reload after leaving fails", async () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    initSafeMode({}, runtimeDir);
    host.reloadIntegrations.mockRejectedValueOnce(new Error("disk full"));

    await expect(leaveSafeMode()).rejects.toThrow("disk full");

    expect(isSafeModeActive()).toBe(false);
    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(false);
    expect(host.reloadFailed).toHaveBeenCalledWith("disk full");
  });

  it("refuses safe mode the environment forces and changes nothing", async () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);

    await expect(leaveSafeMode()).rejects.toThrow(SafeModeForcedError);
    await expect(leaveSafeMode()).rejects.toThrow("Safe mode is forced by OPENMAPX_SAFE_MODE");

    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(true);
    expect(isSafeModeActive()).toBe(true);
    expect(host.reloadIntegrations).not.toHaveBeenCalled();
    expect(attention.resolveAttention).not.toHaveBeenCalled();
  });

  it("still reloads when the attention item cannot be resolved", async () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    initSafeMode({}, runtimeDir);
    attention.resolveAttention.mockRejectedValueOnce(new Error("db down"));

    await expect(leaveSafeMode()).resolves.toMatchObject({ active: false });
    expect(host.reloadIntegrations).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when no integration host is running", async () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    initSafeMode({}, runtimeDir);
    setSafeModeHost(null);

    await expect(leaveSafeMode()).rejects.toThrow("The integration host is not running");
    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(true);
    expect(isSafeModeActive()).toBe(true);
  });

  it("does nothing outside safe mode", async () => {
    initSafeMode({}, runtimeDir);
    await expect(leaveSafeMode()).resolves.toEqual({
      active: false,
      reason: null,
      integrationId: null,
    });
    expect(host.reloadIntegrations).not.toHaveBeenCalled();
  });

  it("keeps this process's own part of the boot marker", async () => {
    const now = Date.now();
    beginBoot(runtimeDir, new Date(now - 120_000));
    markIntegrationLoading("acme", "setup");
    beginBoot(runtimeDir, new Date(now - 60_000));
    markIntegrationLoading("acme", "setup");
    beginBoot(runtimeDir, new Date(now));
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    initSafeMode({}, runtimeDir);
    const marker = () => JSON.parse(readFileSync(join(runtimeDir, "boot-marker.json"), "utf8"));
    expect(marker().uncleanExits).toHaveLength(2);

    await leaveSafeMode();

    expect(marker()).toMatchObject({ running: true, uncleanExits: [] });
  });
});

describe("syncSafeModeAttention", () => {
  const item = {
    key: "safe-mode",
    severity: "warning",
    source: "safe-mode",
    title: "Safe mode is on",
    action: { label: "Leave safe mode", href: "/admin/integrations" },
  };

  it("raises the item with the integration's name while safe mode is automatic", async () => {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "safe-mode.json"),
      '{"mode":"automatic","integrationId":"acme"}',
    );
    initSafeMode({}, runtimeDir);
    host.integrationName.mockReturnValue("Acme Places");

    await syncSafeModeAttention();

    expect(attention.raiseAttention).toHaveBeenCalledWith({
      ...item,
      title: "Safe mode after repeated crashes",
      detail: expect.stringContaining("Acme Places"),
    });
    expect(attention.resolveAttention).not.toHaveBeenCalled();
  });

  it.each([
    [{ OPENMAPX_SAFE_MODE: "1" }, null, "Safe mode is on", "OPENMAPX_SAFE_MODE"],
    [{ OPENMAPX_SAFE_MODE: "1" }, null, "Safe mode is on", "then run pnpm openmapx compose up"],
    [{}, '{"mode":"operator"}', "Safe mode is on", "openmapx control safe-mode off"],
    [
      {},
      '{"mode":"automatic","integrationId":null}',
      "Safe mode after repeated crashes",
      "OpenMapX stopped three times within ten minutes after installed extensions had started loading, so installed extensions were not loaded. The crashes name no extension: find the error OpenMapX stopped with at the end of the API log, disable or update the extension it names, then leave safe mode. If it names none, the cause may be in OpenMapX itself.",
    ],
  ])("names the reason for %j with file %j", async (env, file, title, text) => {
    if (file) writeFileSync(join(runtimeDir, "safe-mode.json"), file);
    initSafeMode(env, runtimeDir);

    await syncSafeModeAttention();

    expect(attention.raiseAttention).toHaveBeenCalledWith({
      ...item,
      title,
      detail: expect.stringContaining(text),
    });
  });

  it("raises a fresh item at the boot that entered automatic safe mode", async () => {
    for (const seconds of [0, 60, 120]) {
      beginBoot(runtimeDir, new Date(Date.UTC(2026, 10, 27, 10, 0, seconds)));
      markIntegrationLoading("acme", "setup");
    }
    expect(beginBoot(runtimeDir, new Date(Date.UTC(2026, 10, 27, 10, 3, 0)))).toEqual({
      enterSafeMode: true,
      integrationId: "acme",
    });
    initSafeMode({}, runtimeDir);
    const order: string[] = [];
    attention.resolveAttention.mockImplementationOnce(async () => {
      order.push("resolve");
    });
    attention.raiseAttention.mockImplementationOnce(async () => {
      order.push("raise");
      return "inserted";
    });

    await syncSafeModeAttention();

    // An acknowledged item would otherwise keep its earlier texts.
    expect(order).toEqual(["resolve", "raise"]);
    expect(attention.raiseAttention).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Safe mode after repeated crashes" }),
    );
  });

  it("raises the same texts at every boot", async () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    initSafeMode({}, runtimeDir);
    await syncSafeModeAttention();
    initSafeMode({}, runtimeDir);
    await syncSafeModeAttention();
    const [first, second] = attention.raiseAttention.mock.calls as unknown as unknown[][];
    expect(second).toEqual(first);
  });

  it("resolves the item outside safe mode", async () => {
    initSafeMode({}, runtimeDir);
    await syncSafeModeAttention();
    expect(attention.resolveAttention).toHaveBeenCalledWith("safe-mode");
    expect(attention.raiseAttention).not.toHaveBeenCalled();
  });

  it("does not reject when the attention list cannot be written", async () => {
    initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);
    attention.raiseAttention.mockRejectedValueOnce(new Error("db down"));
    await expect(syncSafeModeAttention()).resolves.toBeUndefined();
  });
});
