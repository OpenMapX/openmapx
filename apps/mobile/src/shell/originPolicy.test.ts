import { classifyNavigation, type NavigationPolicyConfig } from "./originPolicy";

const config: NavigationPolicyConfig = { webOrigin: "https://openmapx.com" };

describe("classifyNavigation", () => {
  it.each([
    "https://openmapx.com.evil.example/",
    "https://evil.example/?next=https://openmapx.com",
    "https://evil.example/#https://openmapx.com",
    "http://openmapx.com/",
    "https://openmapx.com:444/",
    "https://openmapx.com@evil.example/",
    "https://user:pass@openmapx.com/",
    "https://sub.openmapx.com/",
    "https://openmapx.com./",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,owned",
    "blob:https://openmapx.com/1234",
    "about:blank",
    "content://media/external/images/1",
    "intent://scan/#Intent;scheme=zxing;end",
    "openmapx://navigation/active",
    "not a url at all",
    "",
  ])("never allows %s in the product WebView", (url) => {
    expect(classifyNavigation(url, config)).not.toBe("allow-in-webview");
  });

  it("allows paths on the exact configured origin", () => {
    expect(classifyNavigation("https://openmapx.com/directions?q=x", config)).toBe(
      "allow-in-webview",
    );
  });

  it.each([
    "https://openmapx.com",
    "https://openmapx.com/",
    "https://openmapx.com/place/12345",
    "https://openmapx.com/directions?from=a&to=b#leg-2",
    "https://OPENMAPX.COM/directions",
    "https://openmapx.com:443/directions",
  ])("allows %s", (url) => {
    expect(classifyNavigation(url, config)).toBe("allow-in-webview");
  });

  it.each([
    "https://www.openstreetmap.org/copyright",
    "http://example.org/plain",
    "mailto:hello@openmapx.com",
    "tel:+4915112345678",
  ])("hands %s to the operating system", (url) => {
    expect(classifyNavigation(url, config)).toBe("open-system");
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,owned",
    "blob:https://openmapx.com/1234",
    "about:blank",
    "ftp://openmapx.com/pub",
    "ws://openmapx.com/socket",
    "openmapx://navigation/active",
  ])("rejects %s outright rather than handing it to the OS", (url) => {
    expect(classifyNavigation(url, config)).toBe("reject");
  });

  it("rejects a cleartext or off-port variant of the configured host outright", () => {
    // Same host, different origin is never a link a user meaningfully followed;
    // handing it to the system browser would only obscure a downgrade attempt.
    expect(classifyNavigation("http://openmapx.com/directions", config)).toBe("reject");
    expect(classifyNavigation("https://openmapx.com:8443/", config)).toBe("reject");
  });

  it("rejects credentials embedded in an otherwise matching URL", () => {
    // `new URL("https://user:pass@openmapx.com/").origin` is the product origin,
    // so an origin-only comparison would wrongly allow this.
    expect(classifyNavigation("https://user:pass@openmapx.com/", config)).toBe("reject");
    expect(classifyNavigation("https://openmapx.com:@openmapx.com/", config)).toBe("reject");
  });

  it("rejects oversized URLs before parsing them", () => {
    const huge = `https://openmapx.com/?q=${"a".repeat(64 * 1024)}`;
    expect(classifyNavigation(huge, config)).toBe("reject");
  });

  it("supports an explicit development origin with a port", () => {
    const dev: NavigationPolicyConfig = { webOrigin: "http://localhost:3000" };
    expect(classifyNavigation("http://localhost:3000/directions", dev)).toBe("allow-in-webview");
    expect(classifyNavigation("http://localhost:3001/directions", dev)).toBe("reject");
    expect(classifyNavigation("https://openmapx.com/", dev)).toBe("open-system");
  });

  it.each([null, undefined, 42, {}, []])("rejects the non-string input %p", (value) => {
    expect(classifyNavigation(value as unknown as string, config)).toBe("reject");
  });
});
