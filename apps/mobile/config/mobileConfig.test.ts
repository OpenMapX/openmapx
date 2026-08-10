import { describe, expect, it } from "vitest";
import { readMobileConfig } from "./mobileConfig";

const RELEASE_ENV = {
  OPENMAPX_MOBILE_RELEASE: "1",
  OPENMAPX_APPLE_TEAM_ID: "ABCDEFGHIJ",
} as const;

describe("mobile workspace", () => {
  it("uses the official immutable defaults", () => {
    const config = readMobileConfig(RELEASE_ENV);
    expect(config.webOrigin).toBe("https://openmapx.com");
    expect(config.apiOrigin).toBe("https://openmapx.com");
    expect(config.appId).toBe("org.openmapx.app");
    expect(config.scheme).toBe("openmapx");
    expect(config.appName).toBe("OpenMapX");
  });
});

describe("readMobileConfig origins", () => {
  it.each([
    "http://openmapx.com",
    "https://user:pass@openmapx.com",
    "https://openmapx.com/path",
    "https://openmapx.com?server=other",
    "https://openmapx.com#fragment",
  ])("rejects unsafe release origin %s", (origin) => {
    expect(() =>
      readMobileConfig({ ...RELEASE_ENV, OPENMAPX_MOBILE_WEB_ORIGIN: origin }),
    ).toThrow();
  });

  it.each(["ftp://openmapx.com", "openmapx://openmapx.com", "not a url", ""])(
    "rejects structurally invalid origin %s",
    (origin) => {
      expect(() => readMobileConfig({ OPENMAPX_MOBILE_WEB_ORIGIN: origin })).toThrow();
    },
  );

  it("allows an explicit http development origin", () => {
    const config = readMobileConfig({
      OPENMAPX_MOBILE_RELEASE: "0",
      OPENMAPX_MOBILE_WEB_ORIGIN: "http://localhost:3000",
      OPENMAPX_MOBILE_APP_ID: "org.example.maps",
    });
    expect(config.webOrigin).toBe("http://localhost:3000");
    expect(config.webHost).toBe("localhost");
  });

  it("defaults the API origin to the web origin", () => {
    const config = readMobileConfig({
      ...RELEASE_ENV,
      OPENMAPX_MOBILE_APP_ID: "org.example.maps",
      OPENMAPX_MOBILE_WEB_ORIGIN: "https://maps.example.org",
    });
    expect(config.apiOrigin).toBe("https://maps.example.org");
  });

  it("keeps a distinct API origin when supplied", () => {
    const config = readMobileConfig({
      ...RELEASE_ENV,
      OPENMAPX_MOBILE_APP_ID: "org.example.maps",
      OPENMAPX_MOBILE_WEB_ORIGIN: "https://maps.example.org",
      OPENMAPX_MOBILE_API_ORIGIN: "https://api.example.org",
    });
    expect(config.apiOrigin).toBe("https://api.example.org");
  });
});

describe("readMobileConfig identity", () => {
  it("separates development identity from the store identity", () => {
    expect(readMobileConfig({ OPENMAPX_MOBILE_RELEASE: "0" }).appId).toBe("org.openmapx.app.dev");
  });

  it("gives development builds their own scheme and display name", () => {
    const config = readMobileConfig({ OPENMAPX_MOBILE_RELEASE: "0" });
    expect(config.scheme).toBe("openmapx-dev");
    expect(config.appName).toBe("OpenMapX Dev");
    expect(config.release).toBe(false);
  });

  it.each(["", " org.openmapx.app", "org.openmapx.app ", "openmapx", "org.openmapx", "org..app"])(
    "rejects malformed app id %p",
    (appId) => {
      expect(() => readMobileConfig({ OPENMAPX_MOBILE_APP_ID: appId })).toThrow(/app id/i);
    },
  );

  it.each(["", "1openmapx", "open mapx", "open/mapx"])(
    "rejects malformed URL scheme %p",
    (scheme) => {
      expect(() => readMobileConfig({ OPENMAPX_MOBILE_SCHEME: scheme })).toThrow(/scheme/i);
    },
  );

  it("requires a well-formed Apple Team ID for release builds", () => {
    expect(() => readMobileConfig({ OPENMAPX_MOBILE_RELEASE: "1" })).toThrow(
      /OPENMAPX_APPLE_TEAM_ID/,
    );
    expect(() =>
      readMobileConfig({ OPENMAPX_MOBILE_RELEASE: "1", OPENMAPX_APPLE_TEAM_ID: "abcdefghij" }),
    ).toThrow(/OPENMAPX_APPLE_TEAM_ID/);
    expect(readMobileConfig(RELEASE_ENV).appleTeamId).toBe("ABCDEFGHIJ");
  });

  it("omits the Apple Team ID when a development build does not supply one", () => {
    expect(readMobileConfig({}).appleTeamId).toBeUndefined();
  });
});

describe("readMobileConfig immutability", () => {
  it("returns a frozen record so no runtime server picker can exist", () => {
    const config = readMobileConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { webOrigin: string }).webOrigin = "https://evil.example";
    }).toThrow();
  });

  it("keeps the developer feasibility surface off unless explicitly built in", () => {
    expect(readMobileConfig({}).feasibilityMode).toBe(false);
    expect(readMobileConfig({ OPENMAPX_MOBILE_FEASIBILITY_MODE: "1" }).feasibilityMode).toBe(true);
    expect(readMobileConfig({ OPENMAPX_MOBILE_FEASIBILITY_MODE: "true" }).feasibilityMode).toBe(
      false,
    );
  });
});

describe("release policy", () => {
  it("prevents repointing the official signed identity", () => {
    expect(() =>
      readMobileConfig({
        OPENMAPX_MOBILE_RELEASE: "1",
        OPENMAPX_MOBILE_APP_ID: "org.openmapx.app",
        OPENMAPX_MOBILE_WEB_ORIGIN: "https://maps.example.org",
        OPENMAPX_APPLE_TEAM_ID: "ABCDEFGHIJ",
      }),
    ).toThrow(/official identity/);
  });

  it("prevents pointing the official identity's API elsewhere", () => {
    expect(() =>
      readMobileConfig({
        ...RELEASE_ENV,
        OPENMAPX_MOBILE_API_ORIGIN: "https://api.example.org",
      }),
    ).toThrow(/official identity/);
  });

  it("lets a self-hosted release use its own identity and origin", () => {
    const config = readMobileConfig({
      ...RELEASE_ENV,
      OPENMAPX_MOBILE_APP_ID: "org.example.maps",
      OPENMAPX_MOBILE_SCHEME: "examplemaps",
      OPENMAPX_MOBILE_WEB_ORIGIN: "https://maps.example.org",
    });
    expect(config.appId).toBe("org.example.maps");
    expect(config.webOrigin).toBe("https://maps.example.org");
  });

  it.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.0.0.5",
    "https://192.168.1.20",
    "https://172.16.4.4",
    "https://my-laptop.local",
  ])("rejects the non-public release origin %s", (origin) => {
    expect(() =>
      readMobileConfig({
        ...RELEASE_ENV,
        OPENMAPX_MOBILE_APP_ID: "org.example.maps",
        OPENMAPX_MOBILE_WEB_ORIGIN: origin,
      }),
    ).toThrow(/publicly reachable/);
  });

  it("allows those hosts in a development build", () => {
    expect(
      readMobileConfig({
        OPENMAPX_MOBILE_RELEASE: "0",
        OPENMAPX_MOBILE_WEB_ORIGIN: "http://127.0.0.1:3000",
        OPENMAPX_MOBILE_APP_ID: "org.example.maps",
      }).webHost,
    ).toBe("127.0.0.1");
  });

  it("refuses to ship the developer feasibility surface in a release build", () => {
    expect(() =>
      readMobileConfig({ ...RELEASE_ENV, OPENMAPX_MOBILE_FEASIBILITY_MODE: "1" }),
    ).toThrow(/feasibility/i);
  });

  it("refuses a development app id in a release build", () => {
    expect(() =>
      readMobileConfig({ ...RELEASE_ENV, OPENMAPX_MOBILE_APP_ID: "org.openmapx.app.dev" }),
    ).toThrow(/\.dev/);
  });

  it("rejects a non-default port on the official identity", () => {
    expect(() =>
      readMobileConfig({ ...RELEASE_ENV, OPENMAPX_MOBILE_WEB_ORIGIN: "https://openmapx.com:8443" }),
    ).toThrow(/official identity/);
  });

  it("allows a self-hosted release to use a non-default port", () => {
    expect(
      readMobileConfig({
        ...RELEASE_ENV,
        OPENMAPX_MOBILE_APP_ID: "org.example.maps",
        OPENMAPX_MOBILE_WEB_ORIGIN: "https://maps.example.org:8443",
      }).webOrigin,
    ).toBe("https://maps.example.org:8443");
  });
});
