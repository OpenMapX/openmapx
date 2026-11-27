import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = {
  reloadIntegrations: vi.fn(async () => ({ message: "", reloaded: 0, enabled: 0 })),
  integrationName: vi.fn((_id: string): string | undefined => undefined),
};

const attention = vi.hoisted(() => ({
  raiseAttention: vi.fn(async () => "inserted"),
  resolveAttention: vi.fn(async () => {}),
}));
vi.mock("../services/attention.js", () => attention);

import {
  apiRuntimeDirectory,
  getSafeMode,
  initSafeMode,
  isSafeModeActive,
  leaveSafeMode,
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
    [{}, "not json", { active: true, reason: "operator", integrationId: null }],
    [{ OPENMAPX_SAFE_MODE: "0" }, null, { active: false, reason: null, integrationId: null }],
  ])("reads %j with file %j", (env, file, expected) => {
    if (file !== null) writeFileSync(join(runtimeDir, "safe-mode.json"), file);
    expect(readSafeMode(env, runtimeDir)).toEqual(expected);
  });

  it.each([
    ['{"mode":"automatic"}'],
    ['{"mode":"automatic","integrationId":42}'],
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

  it("uses a temporary directory in host development", () => {
    expect(apiRuntimeDirectory({})).toBe(join(tmpdir(), "openmapx-api-runtime"));
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

  it("is not changed by the file after boot", () => {
    initSafeMode({}, runtimeDir);
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    expect(isSafeModeActive()).toBe(false);
  });
});

describe("leaveSafeMode", () => {
  it("removes the file and the boot marker, resolves the item and reloads", async () => {
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"automatic","integrationId":"a"}');
    writeFileSync(join(runtimeDir, "boot-marker.json"), '{"uncleanExits":3}');
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
    expect(existsSync(join(runtimeDir, "boot-marker.json"))).toBe(false);
    expect(attention.resolveAttention).toHaveBeenCalledWith("safe-mode");
    expect(host.reloadIntegrations).toHaveBeenCalledTimes(1);
    expect(isSafeModeActive()).toBe(false);
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
      detail: expect.stringContaining("Acme Places"),
    });
    expect(attention.resolveAttention).not.toHaveBeenCalled();
  });

  it.each([
    [{ OPENMAPX_SAFE_MODE: "1" }, null, "OPENMAPX_SAFE_MODE"],
    [{}, '{"mode":"operator"}', "openmapx control safe-mode off"],
  ])("names the reason for %j", async (env, file, text) => {
    if (file) writeFileSync(join(runtimeDir, "safe-mode.json"), file);
    initSafeMode(env, runtimeDir);

    await syncSafeModeAttention();

    expect(attention.raiseAttention).toHaveBeenCalledWith({
      ...item,
      detail: expect.stringContaining(text),
    });
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
