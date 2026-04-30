import { describe, expect, it, vi } from "vitest";

// Stub the heavy import chain so the argv-guard tests don't bring in the real
// service registry, postgres client, or CLI runner. We only exercise pure
// validation helpers.
vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/repo",
}));
vi.mock("@openmapx/core", () => ({
  validatePublicUrl: (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error("not a public url");
  },
}));
vi.mock("../admin-cli", () => ({
  assertValidBackupName: vi.fn(),
  runOpenmapxCliJobCommand: vi.fn(),
}));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({
    list: () => [
      { manifest: { id: "valhalla" } },
      { manifest: { id: "osrm" } },
      { manifest: { id: "app-api" } },
    ],
  }),
}));

const { _argvGuards } = await import("../admin-job-handlers");

describe("argv guards", () => {
  describe("rejectFlagLike", () => {
    it("rejects strings starting with '-'", () => {
      expect(() => _argvGuards.rejectFlagLike("--preset=app", "x")).toThrow(/must not begin/);
      expect(() => _argvGuards.rejectFlagLike("-h", "x")).toThrow();
    });
    it("accepts plain values", () => {
      expect(() => _argvGuards.rejectFlagLike("germany", "x")).not.toThrow();
    });
  });

  describe("assertSlug", () => {
    it("accepts typical service ids", () => {
      expect(() => _argvGuards.assertSlug("valhalla", "id")).not.toThrow();
      expect(() => _argvGuards.assertSlug("app-api", "id")).not.toThrow();
      expect(() => _argvGuards.assertSlug("foo_bar.baz", "id")).not.toThrow();
    });
    it("rejects flag-like, empty, or odd-shape input", () => {
      expect(() => _argvGuards.assertSlug("--preset", "id")).toThrow();
      expect(() => _argvGuards.assertSlug("foo bar", "id")).toThrow();
      expect(() => _argvGuards.assertSlug("/etc/passwd", "id")).toThrow();
    });
  });

  describe("assertRegion", () => {
    it("accepts typical region selectors", () => {
      expect(() => _argvGuards.assertRegion("germany")).not.toThrow();
      expect(() => _argvGuards.assertRegion("europe/germany")).not.toThrow();
    });
    it("rejects path traversal and flags", () => {
      expect(() => _argvGuards.assertRegion("../etc")).toThrow();
      expect(() => _argvGuards.assertRegion("--region")).toThrow();
    });
  });

  describe("assertCountries", () => {
    it("accepts ISO codes", () => {
      expect(() => _argvGuards.assertCountries("DE")).not.toThrow();
      expect(() => _argvGuards.assertCountries("DE,CH,AT")).not.toThrow();
    });
    it("rejects malformed input", () => {
      expect(() => _argvGuards.assertCountries("germany")).toThrow();
      expect(() => _argvGuards.assertCountries("--countries=DE")).toThrow();
    });
  });

  describe("assertInsideRepo", () => {
    it("accepts paths that resolve inside the repo", () => {
      expect(_argvGuards.assertInsideRepo("infra/docker/feeds.json", "feedsFile")).toBe(
        "/repo/infra/docker/feeds.json",
      );
      expect(_argvGuards.assertInsideRepo("/repo/data/feeds.json", "feedsFile")).toBe(
        "/repo/data/feeds.json",
      );
    });
    it("rejects path traversal escapes", () => {
      expect(() => _argvGuards.assertInsideRepo("../../etc/passwd", "feedsFile")).toThrow(
        /inside the repo root/,
      );
      expect(() => _argvGuards.assertInsideRepo("/etc/passwd", "feedsFile")).toThrow(
        /inside the repo root/,
      );
    });
    it("rejects flag-like input", () => {
      expect(() => _argvGuards.assertInsideRepo("--output=foo", "output")).toThrow();
    });
  });

  describe("assertKnownServiceIds", () => {
    it("admits ids in the registry", () => {
      expect(() => _argvGuards.assertKnownServiceIds(["valhalla", "osrm"])).not.toThrow();
    });
    it("rejects unknown ids", () => {
      expect(() => _argvGuards.assertKnownServiceIds(["nope"])).toThrow(/Unknown serviceId/);
    });
    it("rejects flag-shaped ids before checking the registry", () => {
      expect(() => _argvGuards.assertKnownServiceIds(["--preset=app"])).toThrow();
    });
  });
});
