import { MobileConfigError, parseRuntimeConfig } from "./runtimeConfig";

const VALID = {
  release: true,
  feasibilityMode: false,
  webOrigin: "https://openmapx.com",
  apiOrigin: "https://openmapx.com",
  webHost: "openmapx.com",
  appId: "org.openmapx.app",
  scheme: "openmapx",
};

describe("parseRuntimeConfig", () => {
  it("accepts and freezes the compiled configuration", () => {
    const config = parseRuntimeConfig(VALID);
    expect(config.webOrigin).toBe("https://openmapx.com");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([undefined, null, {}, "https://openmapx.com", 42])(
    "rejects the malformed manifest value %p",
    (value) => {
      expect(() => parseRuntimeConfig(value)).toThrow(MobileConfigError);
    },
  );

  it("rejects an unexpected extra key so a tampered manifest cannot smuggle state", () => {
    expect(() => parseRuntimeConfig({ ...VALID, serverPicker: true })).toThrow(MobileConfigError);
  });

  it.each([
    "https://openmapx.com/path",
    "https://openmapx.com?next=x",
    "https://user:pass@openmapx.com",
  ])("rejects the non-exact origin %s", (webOrigin) => {
    expect(() => parseRuntimeConfig({ ...VALID, webOrigin })).toThrow(MobileConfigError);
  });

  it("rejects a cleartext origin in a release build", () => {
    expect(() =>
      parseRuntimeConfig({
        ...VALID,
        webOrigin: "http://openmapx.com",
        apiOrigin: "http://openmapx.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it("allows a cleartext origin in a development build", () => {
    const config = parseRuntimeConfig({
      ...VALID,
      release: false,
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:3000",
      webHost: "localhost",
    });
    expect(config.webOrigin).toBe("http://localhost:3000");
  });

  it("never echoes the offending value in its message", () => {
    try {
      parseRuntimeConfig({ ...VALID, webOrigin: "https://attacker.example/steal" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Error).message).not.toContain("attacker.example");
    }
  });
});
