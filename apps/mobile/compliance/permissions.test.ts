import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANDROID_PERMISSIONS,
  diffPermissionSurface,
  expectedPermissionSurface,
  FORBIDDEN_ANDROID_PERMISSIONS,
  FORBIDDEN_IOS_BACKGROUND_MODES,
  FORBIDDEN_IOS_KEYS,
  IOS_BACKGROUND_MODES,
  IOS_USAGE_DESCRIPTION_KEYS,
} from "./permissions";

const registry = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "data-practices.json"), "utf8"),
) as { practices: { id: string }[] };

const practiceIds = new Set(registry.practices.map((practice) => practice.id));
const appConfig = readFileSync(resolve(import.meta.dirname, "../app.config.ts"), "utf8");

describe("every permission is justified", () => {
  it.each([...IOS_USAGE_DESCRIPTION_KEYS, ...IOS_BACKGROUND_MODES, ...ANDROID_PERMISSIONS])(
    "$id names a practice row that exists",
    (entry) => {
      // A permission whose justification does not exist is one that gets
      // improvised during review.
      expect(practiceIds.has(entry.practiceId)).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(15);
    },
  );
});

describe("the permitted surface is minimal", () => {
  it("asks for exactly two iOS usage descriptions", () => {
    expect(expectedPermissionSurface().iosUsageDescriptionKeys).toEqual([
      "NSLocationWhenInUseUsageDescription",
      "NSLocationAlwaysAndWhenInUseUsageDescription",
    ]);
  });

  it("declares location as the only background mode", () => {
    // `audio` would be a second, currently unevidenced, justification for
    // running in the background.
    expect(expectedPermissionSurface().iosBackgroundModes).toEqual(["location"]);
  });

  it("asks for eight Android permissions and no more", () => {
    expect(expectedPermissionSurface().androidPermissions).toEqual([
      "android.permission.INTERNET",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.VIBRATE",
    ]);
  });
});

describe("the app config matches the permitted surface", () => {
  it.each(ANDROID_PERMISSIONS.map((entry) => entry.id))("declares %s", (id) => {
    expect(appConfig).toContain(id);
  });

  it("requests no permission the surface does not name", () => {
    const declared = [...appConfig.matchAll(/"(android\.permission\.[A-Z_]+)"/g)].map(
      (match) => match[1],
    );
    const permitted = new Set(expectedPermissionSurface().androidPermissions);
    // Everything else in the config must be in `blockedPermissions`, not in
    // `permissions` — the test reads both, so an entry appearing in neither list
    // is what this catches.
    const blockedSection = appConfig.slice(appConfig.indexOf("blockedPermissions"));
    for (const id of declared) {
      if (permitted.has(id)) continue;
      expect({ id, blocked: blockedSection.includes(id) }).toEqual({ id, blocked: true });
    }
  });

  it("blocks the capabilities that would otherwise arrive by default", () => {
    for (const id of [
      "com.google.android.c2dm.permission.RECEIVE",
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
      "android.permission.QUERY_ALL_PACKAGES",
    ]) {
      expect(appConfig).toContain(id);
    }
  });

  it("declares no tablet support", () => {
    // Phone is the supported first-release form factor and the store metadata
    // claims nothing else.
    expect(appConfig).toContain("supportsTablet: false");
  });

  it("declares encryption as exempt", () => {
    expect(appConfig).toContain("usesNonExemptEncryption: false");
  });
});

describe("diffPermissionSurface", () => {
  it("accepts the exact permitted surface", () => {
    expect(diffPermissionSurface(expectedPermissionSurface())).toEqual([]);
  });

  it.each(Object.keys(FORBIDDEN_ANDROID_PERMISSIONS))("rejects %s with its reason", (id) => {
    const violations = diffPermissionSurface({
      androidPermissions: [...expectedPermissionSurface().androidPermissions, id],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "forbidden", id });
    expect(violations[0].reason).toBe(FORBIDDEN_ANDROID_PERMISSIONS[id]);
  });

  it.each(Object.keys(FORBIDDEN_IOS_KEYS))("rejects the iOS key %s", (id) => {
    const violations = diffPermissionSurface({
      iosUsageDescriptionKeys: [...expectedPermissionSurface().iosUsageDescriptionKeys, id],
    });

    expect(violations[0]).toMatchObject({ kind: "forbidden", id });
  });

  it.each(Object.keys(FORBIDDEN_IOS_BACKGROUND_MODES))("rejects the background mode %s", (id) => {
    const violations = diffPermissionSurface({ iosBackgroundModes: ["location", id] });

    expect(violations[0]).toMatchObject({ kind: "forbidden", id });
  });

  it("reports something nobody has considered as unexpected, not forbidden", () => {
    const violations = diffPermissionSurface({
      androidPermissions: [
        ...expectedPermissionSurface().androidPermissions,
        "android.permission.SOMETHING_NEW",
      ],
    });

    // Arguably the more alarming of the two: a denylist would have missed it.
    expect(violations[0]).toMatchObject({
      kind: "unexpected",
      id: "android.permission.SOMETHING_NEW",
    });
  });

  it("reports a missing required permission", () => {
    const violations = diffPermissionSurface({
      androidPermissions: expectedPermissionSurface().androidPermissions.filter(
        (id) => id !== "android.permission.ACCESS_FINE_LOCATION",
      ),
    });

    expect(violations).toEqual([
      expect.objectContaining({ kind: "missing", id: "android.permission.ACCESS_FINE_LOCATION" }),
    ]);
  });

  it("checks only the platforms it was given", () => {
    // A partial observation — an Info.plist with no manifest alongside it —
    // must not report every Android permission as missing.
    expect(diffPermissionSurface({ iosBackgroundModes: ["location"] })).toEqual([]);
  });
});
