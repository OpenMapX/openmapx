import { describe, expect, it } from "vitest";
import { isPublicUrl, validatePublicUrl } from "./validate-url";

describe("isPublicUrl", () => {
  it.each([
    "https://example.com/feed",
    "http://93.184.216.34/feed",
    "https://[2606:4700:4700::1111]/feed",
  ])("accepts %s", (url) => {
    expect(isPublicUrl(url)).toBe(true);
  });

  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "ftp://example.com/",
    "not a url",
  ])("rejects the private or non-HTTP target %s", (url) => {
    expect(isPublicUrl(url)).toBe(false);
  });

  describe("IPv4 addresses written as IPv6 literals", () => {
    // Node's URL parser rewrites each of these spellings to a bracketed hex form
    // such as [::ffff:7f00:1], so the check has to read that form.
    it.each([
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[::FFFF:7F00:1]/",
      "http://[0:0:0:0:0:ffff:127.0.0.1]/",
      "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:a00:1]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:100.64.0.1]/",
      "http://[::ffff:0.0.0.0]/",
      "http://[::ffff:0:0]/",
      "https://[::ffff:127.0.0.1]:8443/path?x=1#y",
    ])("rejects the mapped address %s", (url) => {
      expect(isPublicUrl(url)).toBe(false);
    });

    it.each([
      "http://[::ffff:8.8.8.8]/",
      "http://[::ffff:808:808]/",
      "http://[::ffff:93.184.216.34]/",
    ])("rejects a mapped address even when the IPv4 address is public: %s", (url) => {
      expect(isPublicUrl(url)).toBe(false);
    });

    it.each([
      "http://[::]/",
      "http://[0:0:0:0:0:0:0:0]/",
      "http://[::127.0.0.1]/",
      "http://[::7f00:1]/",
      "http://[::a00:1]/",
      "http://[::ffff:0:127.0.0.1]/",
      "http://[::ffff:0:7f00:1]/",
    ])("rejects the compatible or translated address %s", (url) => {
      expect(isPublicUrl(url)).toBe(false);
    });

    it("throws from validatePublicUrl for a mapped address", () => {
      expect(() => validatePublicUrl("http://[::ffff:7f00:1]/")).toThrow(/private/);
    });

    it("keeps accepting public IPv6 addresses that merely start like a mapped one", () => {
      expect(isPublicUrl("http://[2001:db8::ffff:7f00:1]/")).toBe(true);
      expect(isPublicUrl("http://[::fffe:7f00:1]/")).toBe(true);
      expect(isPublicUrl("http://[1::ffff:7f00:1]/")).toBe(true);
    });
  });
});
