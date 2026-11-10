import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderCompose, renderServiceSnippet } from "../services/compose-renderer";
import { validateServiceManifest } from "../services/manifest-schema";
import type { LoadedService, ServiceManifest } from "../services/types";

const tempDirs: string[] = [];
const validateExternal = (raw: unknown) => validateServiceManifest(raw, { firstParty: false });
const validateFirstParty = (raw: unknown) => validateServiceManifest(raw, { firstParty: true });

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempServiceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-sandbox-"));
  tempDirs.push(dir);
  return dir;
}

function externalService(
  id: string,
  directory: string,
  overrides: Partial<ServiceManifest> = {},
): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "community",
      container: { image: `t/${id}`, tag: "latest", expose: [80], memory: "256m" },
      ...overrides,
    },
    directory,
    isBuiltIn: false,
    enabled: true,
  };
}

function firstPartyService(
  id: string,
  directory: string,
  overrides: Partial<ServiceManifest> = {},
): LoadedService {
  return {
    ...externalService(id, directory, { ...overrides, quality: "built-in" }),
    isBuiltIn: true,
  };
}

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are literal Docker Compose references under test
describe("third-party static sandbox policy", () => {
  it("rejects a community proxy request with a stable validation code", () => {
    const result = validateExternal({
      id: "community-proxy",
      name: "Community Proxy",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m", expose: [8080] },
      exposure: { proxy: { enabled: true } },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "community_proxy_forbidden: exposure.proxy.enabled is not allowed for community services",
    );
  });

  it("allows a community manifest without proxy exposure", () => {
    const result = validateExternal({
      id: "community-private",
      name: "Community Private",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m", expose: [8080] },
    });

    expect(result.valid).toBe(true);
  });

  it("rejects writable community bind mounts with a stable validation code", () => {
    const result = validateExternal({
      id: "community-writable-bind",
      name: "Community Writable Bind",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m" },
      bindMounts: [{ source: "runtime/state", target: "/state", readOnly: false }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "community_bind_mount_forbidden: bindMounts are not allowed for community services",
    );
  });

  it("rejects read-only community bind mounts with a stable validation code", () => {
    const result = validateExternal({
      id: "community-readonly-bind",
      name: "Community Readonly Bind",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m" },
      bindMounts: [
        { source: "config/settings.json", target: "/etc/settings.json", readOnly: true },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "community_bind_mount_forbidden: bindMounts are not allowed for community services",
    );
  });

  it("keeps namespaced community named volumes valid", () => {
    const result = validateExternal({
      id: "community-state",
      name: "Community State",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m" },
      volumes: [{ name: "openmapx-community-state-data", mountAt: "/state" }],
    });

    expect(result.valid).toBe(true);
  });

  it("preserves first-party host-path mounts", () => {
    const firstParty = validateFirstParty({
      id: "app-api",
      name: "App API",
      version: "1.0.0",
      quality: "built-in",
      container: { image: "alpine", tag: "latest", memory: "256m" },
      bindMounts: [
        {
          source: "${OPENMAPX_HOST_DIR:?OPENMAPX_HOST_DIR must be set}",
          target: "${OPENMAPX_HOST_DIR:?OPENMAPX_HOST_DIR must be set}",
          readOnly: false,
        },
      ],
    });
    expect(firstParty.valid).toBe(true);
  });

  it("rejects deployment env files for third-party services", () => {
    const result = validateExternal({
      id: "evil",
      name: "Evil",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m", envFile: [".env"] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/container\.envFile/);

    const firstParty = validateFirstParty({
      id: "app-api",
      name: "App API",
      version: "1.0.0",
      quality: "built-in",
      container: { image: "alpine", tag: "latest", memory: "256m", envFile: [".env"] },
    });
    expect(firstParty.valid).toBe(true);
  });

  it("namespaces third-party named volumes", () => {
    const stolen = validateExternal({
      id: "evil",
      name: "Evil",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m" },
      volumes: [{ name: "openmapx-pgdata", mountAt: "/steal" }],
    });
    expect(stolen.valid).toBe(false);
    expect(stolen.errors.join(" ")).toMatch(/openmapx-evil-<suffix>/);

    const namespaced = validateExternal({
      id: "evil",
      name: "Evil",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m" },
      volumes: [{ name: "openmapx-evil-state", mountAt: "/state" }],
    });
    expect(namespaced.valid).toBe(true);
  });

  it("rejects a Compose logging block for third-party services but keeps it for first-party ones", () => {
    const manifest = (quality: string) => ({
      id: "chatty",
      name: "Chatty",
      version: "1.0.0",
      quality,
      container: {
        image: "alpine",
        tag: "latest",
        logging: { driver: "syslog", options: { "syslog-address": "tcp://203.0.113.5:514" } },
      },
    });

    const community = validateExternal(manifest("community"));
    expect(community.valid).toBe(false);
    expect(community.errors.join(" ")).toMatch(/container\.logging/);
    expect(validateFirstParty(manifest("built-in")).valid).toBe(true);
  });

  it("rejects an explicitly writable consumes mount for third-party services", () => {
    const manifest = (readOnly: boolean | undefined, quality: string) => ({
      id: "reader",
      name: "Reader",
      version: "1.0.0",
      quality,
      container: { image: "alpine", tag: "latest", memory: "256m" },
      consumes: [
        {
          type: "osm-pbf",
          mountAt: "/data",
          ...(readOnly === undefined ? {} : { readOnly }),
        },
      ],
    });

    const writable = validateExternal(manifest(false, "community"));
    expect(writable.valid).toBe(false);
    expect(writable.errors.join(" ")).toMatch(/consumes.*readOnly/);
    expect(validateExternal(manifest(true, "community")).valid).toBe(true);
    expect(validateExternal(manifest(undefined, "community")).valid).toBe(true);
    expect(validateFirstParty(manifest(false, "built-in")).valid).toBe(true);
  });

  it("accepts only an IP address as a host-port bind address", () => {
    const manifest = (bindAddress: string) => ({
      id: "listener",
      name: "Listener",
      version: "1.0.0",
      quality: "community",
      container: { image: "alpine", tag: "latest", memory: "256m" },
      exposure: { hostPorts: [{ container: 80, host: 8080, bindAddress }] },
    });

    for (const ok of ["127.0.0.1", "0.0.0.0", "192.168.1.10", "::1", "fd00::1"]) {
      expect(validateExternal(manifest(ok)).valid, ok).toBe(true);
    }
    for (const bad of [
      "${POSTGRES_PASSWORD}",
      "$HOST",
      "localhost",
      "127.0.0.1:8080",
      "[::1]",
      "999.0.0.1",
      "",
    ]) {
      expect(validateExternal(manifest(bad)).valid, bad).toBe(false);
    }
  });
});

describe("third-party render sandbox", () => {
  it("rejects a hand-built community bind mount at the render boundary", () => {
    const directory = tempServiceDir();
    const service = externalService(directory.split("/").pop() ?? "evil", directory, {
      bindMounts: [{ source: "runtime/state", target: "/state" }],
    });

    expect(() => renderCompose([service], {})).toThrow(/community_bind_mount_forbidden/);
  });

  it("rejects aliases that squat on another service and allows the service's own id", () => {
    const directory = tempServiceDir();
    const database = firstPartyService("postgis", directory);
    const impostor = externalService("evil", directory, {
      container: { image: "alpine", tag: "latest", memory: "256m", networkAliases: ["postgis"] },
    });
    expect(() => renderCompose([database, impostor], {})).toThrow(/postgis/);

    const selfAlias = externalService("evil", directory, {
      container: { image: "alpine", tag: "latest", memory: "256m", networkAliases: ["evil"] },
    });
    expect(() => renderCompose([selfAlias], {})).not.toThrow();
  });

  it("rejects cross-service volume collisions", () => {
    const directory = tempServiceDir();
    const owner = firstPartyService("owner", directory, {
      volumes: [{ name: "openmapx-evil-state", mountAt: "/state" }],
    });
    const claimant = externalService("evil", directory, {
      volumes: [{ name: "openmapx-evil-state", mountAt: "/state" }],
    });

    expect(() => renderCompose([owner, claimant], {})).toThrow(/already declared/);
  });

  it("re-checks a hand-built LoadedService at renderServiceSnippet", () => {
    const service = externalService("evil", tempServiceDir(), {
      container: { image: "alpine", tag: "latest", memory: "256m", privileged: true },
    });
    expect(() => renderServiceSnippet(service, {})).toThrow(/privileged/);
  });

  it("rejects hand-built community network access at the render boundary", () => {
    const service = externalService("evil", tempServiceDir(), {
      communityNetworkAccess: ["trusted-extension"],
    } as never);
    expect(() => renderServiceSnippet(service, {})).toThrow(/community_network_access_forbidden/);
  });

  it("rejects a hand-built empty community network declaration at the render boundary", () => {
    const service = externalService("evil", tempServiceDir(), {
      communityNetworkAccess: [],
    });
    expect(() => renderServiceSnippet(service, {})).toThrow(/community_network_access_forbidden/);
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: these are literal Docker Compose references under test
