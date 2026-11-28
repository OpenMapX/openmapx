import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginBoot,
  bootMarkerDirectory,
  checkRuntimeDirectory,
  markCleanStop,
  markIntegrationLoaded,
  markIntegrationLoading,
  recordFatal,
} from "../safe-mode.js";

let dir: string;

const t0 = new Date("2026-11-27T10:00:00.000Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const t1 = at(30);

function readMarker(directory: string) {
  return JSON.parse(readFileSync(join(directory, "boot-marker.json"), "utf8"));
}

function safeModeFile() {
  return JSON.parse(readFileSync(join(dir, "safe-mode.json"), "utf8"));
}

/** One process that loaded `integrationId` and then ended without a stop request. */
function crashedWhileLoading(seconds: number, integrationId = "acme") {
  beginBoot(dir, at(seconds));
  markIntegrationLoading(integrationId, "setup");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omx-boot-marker-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the boot marker", () => {
  it("does not count a clean stop", () => {
    beginBoot(dir, t0);
    markIntegrationLoading("acme", "setup");
    markIntegrationLoaded();
    markCleanStop();
    expect(beginBoot(dir, t1)).toEqual({ enterSafeMode: false, integrationId: null });
    expect(readMarker(dir).uncleanExits).toHaveLength(0);
  });

  it("counts a stop request as clean even when shutdown never finishes", () => {
    beginBoot(dir, t0);
    markIntegrationLoading("acme", "setup");
    markCleanStop();
    expect(beginBoot(dir, t1)).toEqual({ enterSafeMode: false, integrationId: null });
    expect(readMarker(dir).uncleanExits).toHaveLength(0);
  });

  it("does not count exits before any installed integration was loaded", () => {
    beginBoot(dir, at(0));
    beginBoot(dir, at(60));
    beginBoot(dir, at(120));
    expect(beginBoot(dir, at(180))).toEqual({ enterSafeMode: false, integrationId: null });
    expect(readMarker(dir).uncleanExits).toHaveLength(0);
  });

  it("enters safe mode at the third unclean exit within ten minutes and names the integration", () => {
    crashedWhileLoading(0);
    crashedWhileLoading(60);
    crashedWhileLoading(120);
    expect(beginBoot(dir, at(180))).toEqual({ enterSafeMode: true, integrationId: "acme" });
    expect(safeModeFile()).toEqual({ mode: "automatic", integrationId: "acme" });
    expect(readMarker(dir).uncleanExits).toEqual([]);
  });

  it("records each unclean exit with the integration it was loading", () => {
    crashedWhileLoading(0);
    expect(beginBoot(dir, at(60))).toEqual({ enterSafeMode: false, integrationId: null });
    expect(readMarker(dir)).toEqual({
      version: 1,
      running: true,
      installedCodeStarted: false,
      current: null,
      lastFatal: null,
      uncleanExits: [{ at: at(60).toISOString(), integrationId: "acme" }],
    });
    expect(existsSync(join(dir, "safe-mode.json"))).toBe(false);
  });

  it("does not count exits older than ten minutes", () => {
    crashedWhileLoading(0);
    crashedWhileLoading(60);
    crashedWhileLoading(900);
    expect(beginBoot(dir, at(1_000))).toEqual({ enterSafeMode: false, integrationId: null });
    expect(readMarker(dir).uncleanExits).toEqual([
      { at: at(900).toISOString(), integrationId: "acme" },
      { at: at(1_000).toISOString(), integrationId: "acme" },
    ]);
    expect(existsSync(join(dir, "safe-mode.json"))).toBe(false);
  });

  it("counts a crash at run time after loading finished", () => {
    for (const seconds of [0, 60, 120]) {
      beginBoot(dir, at(seconds));
      markIntegrationLoading("acme", "import");
      markIntegrationLoading("acme", "setup");
      markIntegrationLoaded();
      recordFatal("acme");
    }
    expect(beginBoot(dir, at(180))).toEqual({ enterSafeMode: true, integrationId: "acme" });
    expect(safeModeFile()).toEqual({ mode: "automatic", integrationId: "acme" });
  });

  it("enters safe mode without a name when none is known", () => {
    for (const seconds of [0, 60, 120]) {
      beginBoot(dir, at(seconds));
      markIntegrationLoading("acme", "setup");
      markIntegrationLoaded();
      recordFatal(null);
    }
    expect(beginBoot(dir, at(180))).toEqual({ enterSafeMode: true, integrationId: null });
    expect(safeModeFile()).toEqual({ mode: "automatic", integrationId: null });
  });

  it("names the integration named most often, and none on a tie", () => {
    crashedWhileLoading(0, "acme");
    crashedWhileLoading(60, "beta");
    crashedWhileLoading(120, "acme");
    expect(beginBoot(dir, at(180))).toEqual({ enterSafeMode: true, integrationId: "acme" });

    rmSync(join(dir, "safe-mode.json"));
    crashedWhileLoading(200, "acme");
    crashedWhileLoading(260, "beta");
    beginBoot(dir, at(320));
    markIntegrationLoading("gamma", "import");
    markIntegrationLoaded();
    expect(beginBoot(dir, at(380))).toEqual({ enterSafeMode: true, integrationId: null });
  });

  it("names the integration a fatal error named over the one that was loading", () => {
    // An integration loaded earlier fails from a timer while another loads.
    beginBoot(dir, t0);
    markIntegrationLoading("acme", "import");
    recordFatal("other");
    beginBoot(dir, t1);
    expect(readMarker(dir).uncleanExits).toEqual([
      { at: t1.toISOString(), integrationId: "other" },
    ]);
  });

  it("names the integration that was loading when the fatal error named none", () => {
    beginBoot(dir, t0);
    markIntegrationLoading("acme", "import");
    recordFatal(null);
    beginBoot(dir, t1);
    expect(readMarker(dir).uncleanExits).toEqual([{ at: t1.toISOString(), integrationId: "acme" }]);
  });

  it("drops an exit dated after now, as after the clock went back", () => {
    writeFileSync(
      join(dir, "boot-marker.json"),
      JSON.stringify({
        version: 1,
        running: false,
        installedCodeStarted: true,
        current: null,
        lastFatal: null,
        uncleanExits: [
          { at: at(60).toISOString(), integrationId: "acme" },
          { at: at(120).toISOString(), integrationId: "acme" },
          { at: at(-60).toISOString(), integrationId: "acme" },
        ],
      }),
    );
    beginBoot(dir, t0);
    expect(readMarker(dir).uncleanExits).toEqual([
      { at: at(-60).toISOString(), integrationId: "acme" },
    ]);
  });

  it("leaves no temporary file behind when a write fails", () => {
    // A directory where the marker belongs makes every rename over it fail.
    mkdirSync(join(dir, "boot-marker.json"));
    beginBoot(dir, t0);
    markIntegrationLoading("acme", "import");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    ["not json"],
    ['{"uncleanExits":3}'],
    ["null"],
    ['{"version":2,"running":true,"installedCodeStarted":true}'],
  ])("treats a malformed marker as empty (%s)", (text) => {
    writeFileSync(join(dir, "boot-marker.json"), text);
    expect(beginBoot(dir, t0)).toEqual({ enterSafeMode: false, integrationId: null });
    expect(readMarker(dir)).toEqual({
      version: 1,
      running: true,
      installedCodeStarted: false,
      current: null,
      lastFatal: null,
      uncleanExits: [],
    });
  });

  it("ignores malformed entries of an otherwise readable marker", () => {
    writeFileSync(
      join(dir, "boot-marker.json"),
      JSON.stringify({
        version: 1,
        running: false,
        installedCodeStarted: false,
        current: null,
        lastFatal: null,
        uncleanExits: [
          { at: at(-10).toISOString(), integrationId: "acme" },
          { at: "yesterday", integrationId: "acme" },
          { at: at(-5).toISOString(), integrationId: 42 },
        ],
      }),
    );
    beginBoot(dir, t0);
    expect(readMarker(dir).uncleanExits).toEqual([
      { at: at(-10).toISOString(), integrationId: "acme" },
    ]);
  });

  it("starts the API when the marker cannot be written", () => {
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "");
    expect(beginBoot(file, t0)).toEqual({ enterSafeMode: false, integrationId: null });
    expect(() => markIntegrationLoading("acme", "setup")).not.toThrow();
    expect(() => markIntegrationLoaded()).not.toThrow();
    expect(() => recordFatal("acme")).not.toThrow();
    expect(() => markCleanStop()).not.toThrow();
  });

  it("neither reads nor writes through a runtime directory that is a symbolic link", () => {
    const target = join(dir, "elsewhere");
    mkdirSync(target);
    const crashed = JSON.stringify({
      version: 1,
      running: true,
      installedCodeStarted: true,
      current: { integrationId: "acme", phase: "setup" },
      lastFatal: null,
      uncleanExits: [
        { at: at(-60).toISOString(), integrationId: "acme" },
        { at: at(-30).toISOString(), integrationId: "acme" },
      ],
    });
    writeFileSync(join(target, "boot-marker.json"), crashed);
    const link = join(dir, "link");
    symlinkSync(target, link);
    expect(beginBoot(link, t0)).toEqual({ enterSafeMode: false, integrationId: null });
    expect(bootMarkerDirectory()).toBeNull();
    markIntegrationLoading("acme", "import");
    recordFatal("acme");
    markCleanStop();
    expect(readdirSync(target)).toEqual(["boot-marker.json"]);
    expect(readFileSync(join(target, "boot-marker.json"), "utf8")).toBe(crashed);
  });

  it("names the directory it writes the marker in", () => {
    beginBoot(dir, t0);
    expect(bootMarkerDirectory()).toBe(dir);
  });

  it("does not write through a file left at the temporary name", () => {
    const outside = join(dir, "outside");
    writeFileSync(outside, "keep");
    const runtime = join(dir, "runtime");
    mkdirSync(runtime);
    symlinkSync(outside, join(runtime, `boot-marker.json.${process.pid}.tmp`));
    beginBoot(runtime, t0);
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(readMarker(runtime)).toMatchObject({ running: true });
    expect(readdirSync(runtime)).toEqual(["boot-marker.json"]);
  });

  it("writes the marker as the process goes", () => {
    beginBoot(dir, t0);
    markIntegrationLoading("acme", "import");
    expect(readMarker(dir)).toMatchObject({
      running: true,
      installedCodeStarted: true,
      current: { integrationId: "acme", phase: "import" },
    });
    markIntegrationLoading("acme", "setup");
    expect(readMarker(dir).current).toEqual({ integrationId: "acme", phase: "setup" });
    markIntegrationLoaded();
    expect(readMarker(dir)).toMatchObject({ installedCodeStarted: true, current: null });
    recordFatal("acme");
    expect(readMarker(dir).lastFatal).toEqual({ integrationId: "acme", at: expect.any(String) });
    markCleanStop();
    expect(readMarker(dir)).toMatchObject({ running: false, installedCodeStarted: true });
  });

  it("keeps unclean exits another process cleared while this one runs", () => {
    crashedWhileLoading(0);
    beginBoot(dir, at(60));
    const cleared = { ...readMarker(dir), uncleanExits: [] };
    writeFileSync(join(dir, "boot-marker.json"), JSON.stringify(cleared));
    markIntegrationLoading("acme", "import");
    markCleanStop();
    expect(readMarker(dir).uncleanExits).toEqual([]);
  });
});

describe("checkRuntimeDirectory", () => {
  const uid = process.geteuid?.() ?? null;

  it("creates a missing directory for this user only", () => {
    const path = join(dir, "a", "runtime");
    expect(checkRuntimeDirectory(path, uid)).toBeNull();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it("accepts an existing directory of this user", () => {
    expect(checkRuntimeDirectory(dir, uid)).toBeNull();
  });

  it("refuses a symbolic link, even to a directory of this user", () => {
    const link = join(dir, "link");
    symlinkSync(dir, link);
    expect(checkRuntimeDirectory(link, uid)).toMatch(/symbolic link/);
    expect(checkRuntimeDirectory(link, null)).toMatch(/symbolic link/);
  });

  it("refuses a path that is not a directory", () => {
    const file = join(dir, "file");
    writeFileSync(file, "");
    expect(checkRuntimeDirectory(file, null)).toMatch(/not a directory/);
  });

  it.runIf(uid !== null)("refuses a directory another user owns", () => {
    expect(checkRuntimeDirectory(dir, (uid ?? 0) + 1)).toMatch(/belongs to uid/);
  });

  it.runIf(uid !== null)("refuses a directory others may write to", () => {
    chmodSync(dir, 0o777);
    expect(checkRuntimeDirectory(dir, uid)).toMatch(/writable by other users/);
  });

  it("leaves owner and mode unchecked when no owner is asked for", () => {
    chmodSync(dir, 0o777);
    expect(checkRuntimeDirectory(dir, null)).toBeNull();
  });
});
