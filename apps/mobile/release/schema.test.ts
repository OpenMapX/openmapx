import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareWithPrevious,
  type Environment,
  type ReleaseVersion,
  type ToolchainPins,
  validateEnvironment,
  validateReleaseVersion,
} from "./schema";

/**
 * Each rule here corresponds to something a store rejects late — at upload, or
 * after processing, once an archive has been built and transferred. Discovering
 * them locally in a second is the entire point.
 */

const VERSION: ReleaseVersion = {
  marketingVersion: "1.0.0",
  iosBuildNumber: "1",
  androidVersionCode: 1,
  androidVersionName: "1.0.0",
  protocol: { min: 1, max: 2 },
  minimumWebBuild: null,
  channel: "beta",
};

const TOOLCHAINS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "toolchains.json"), "utf8"),
) as ToolchainPins;

const ENVIRONMENT: Environment = {
  nodeMajor: 24,
  javaMajor: 17,
  origin: "https://openmapx.com",
  appId: "org.openmapx.app",
  dirtyTrackedFiles: [],
};

const fields = (issues: { field: string }[]) => issues.map((issue) => issue.field);

describe("the committed version.json", () => {
  const committed = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "version.json"), "utf8"),
  ) as ReleaseVersion;

  it("is valid", () => {
    expect(validateReleaseVersion(committed)).toEqual([]);
  });

  it("supports the protocol range the code actually implements", async () => {
    const { MOBILE_PROTOCOL_MIN, MOBILE_PROTOCOL_MAX } = await import("@openmapx/core/navigation");

    // A release claiming a range the binary cannot negotiate would hand every
    // page a handshake it fails.
    expect(committed.protocol.min).toBe(MOBILE_PROTOCOL_MIN);
    expect(committed.protocol.max).toBe(MOBILE_PROTOCOL_MAX);
  });
});

describe("validateReleaseVersion", () => {
  it("accepts a well-formed release", () => {
    expect(validateReleaseVersion(VERSION)).toEqual([]);
  });

  it.each(["1.0", "v1.0.0", "1.0.0-beta", "01.0.0", ""])(
    "rejects the marketing version %j",
    (marketingVersion) => {
      const issues = validateReleaseVersion({ ...VERSION, marketingVersion });

      expect(fields(issues)).toContain("marketingVersion");
    },
  );

  it.each([0, -1, 1.5])("rejects the Android version code %s", (androidVersionCode) => {
    expect(fields(validateReleaseVersion({ ...VERSION, androidVersionCode }))).toContain(
      "androidVersionCode",
    );
  });

  it("rejects a version code above what Play accepts", () => {
    // Hitting the cap is unrecoverable for the listing.
    expect(
      fields(validateReleaseVersion({ ...VERSION, androidVersionCode: 2_200_000_000 })),
    ).toContain("androidVersionCode");
  });

  it("requires the two stores to show the same number", () => {
    expect(fields(validateReleaseVersion({ ...VERSION, androidVersionName: "1.0.1" }))).toContain(
      "androidVersionName",
    );
  });

  it.each([
    { label: "an inverted range", protocol: { min: 3, max: 2 } },
    { label: "a zero minimum", protocol: { min: 0, max: 2 } },
  ])("rejects $label", ({ protocol }) => {
    expect(fields(validateReleaseVersion({ ...VERSION, protocol }))).toContain("protocol");
  });

  it("rejects an unknown channel", () => {
    expect(fields(validateReleaseVersion({ ...VERSION, channel: "canary" }))).toContain("channel");
  });

  it("rejects a non-object", () => {
    expect(validateReleaseVersion("1.0.0")).toHaveLength(1);
  });
});

describe("compareWithPrevious", () => {
  it("accepts the first release", () => {
    expect(compareWithPrevious(VERSION, null)).toEqual([]);
  });

  it("accepts a genuine increment", () => {
    const next = {
      ...VERSION,
      marketingVersion: "1.0.1",
      androidVersionName: "1.0.1",
      androidVersionCode: 2,
      iosBuildNumber: "2",
    };

    expect(compareWithPrevious(next, VERSION)).toEqual([]);
  });

  it("rejects a duplicate Android version code", () => {
    // Play rejects this at upload, after the bundle has been built and signed.
    expect(fields(compareWithPrevious(VERSION, VERSION))).toContain("androidVersionCode");
  });

  it("rejects a lower iOS build number", () => {
    const previous = { ...VERSION, iosBuildNumber: "9" };

    expect(fields(compareWithPrevious(VERSION, previous))).toContain("iosBuildNumber");
  });

  it("rejects a marketing-version rollback", () => {
    const previous = { ...VERSION, marketingVersion: "1.1.0", androidVersionName: "1.1.0" };

    // A rollback needs a new higher version, not an old one.
    expect(fields(compareWithPrevious(VERSION, previous))).toContain("marketingVersion");
  });

  it("rejects raising the protocol minimum", () => {
    const next = {
      ...VERSION,
      protocol: { min: 2, max: 2 },
      androidVersionCode: 2,
      iosBuildNumber: "2",
    };

    // Deployed web builds still speaking v1 would stop working, and they cannot
    // be updated in lockstep with a store release.
    expect(fields(compareWithPrevious(next, VERSION))).toContain("protocol.min");
  });
});

describe("validateEnvironment", () => {
  it("accepts a clean release machine", () => {
    expect(validateEnvironment(ENVIRONMENT, TOOLCHAINS, VERSION)).toEqual([]);
  });

  it("refuses a dirty worktree", () => {
    const issues = validateEnvironment(
      { ...ENVIRONMENT, dirtyTrackedFiles: ["apps/mobile/src/App.tsx"] },
      TOOLCHAINS,
      VERSION,
    );

    // The provenance manifest would record a commit that does not describe what
    // was built.
    expect(fields(issues)).toContain("worktree");
  });

  it("refuses a JDK the Android build cannot use", () => {
    // AGP's JdkImageTransform fails deep inside Gradle with an unrelated-looking
    // message, so catching it here saves a long detour.
    expect(
      fields(validateEnvironment({ ...ENVIRONMENT, javaMajor: 26 }, TOOLCHAINS, VERSION)),
    ).toContain("java");
  });

  it("accepts a machine with no JDK when only iOS is being built", () => {
    expect(validateEnvironment({ ...ENVIRONMENT, javaMajor: null }, TOOLCHAINS, VERSION)).toEqual(
      [],
    );
  });

  it("refuses an old Node", () => {
    expect(
      fields(validateEnvironment({ ...ENVIRONMENT, nodeMajor: 20 }, TOOLCHAINS, VERSION)),
    ).toContain("node");
  });

  it.each(["http://openmapx.com", "https://localhost:3000", "http://127.0.0.1:3000"])(
    "refuses to build a release against %s",
    (origin) => {
      expect(
        fields(validateEnvironment({ ...ENVIRONMENT, origin }, TOOLCHAINS, VERSION)),
      ).toContain("origin");
    },
  );

  it("refuses a development application identifier", () => {
    expect(
      fields(
        validateEnvironment({ ...ENVIRONMENT, appId: "org.openmapx.app.dev" }, TOOLCHAINS, VERSION),
      ),
    ).toContain("appId");
  });

  it("refuses a 0.x production release", () => {
    const version = {
      ...VERSION,
      marketingVersion: "0.9.0",
      androidVersionName: "0.9.0",
      channel: "production" as const,
    };

    expect(fields(validateEnvironment(ENVIRONMENT, TOOLCHAINS, version))).toContain("channel");
  });
});
