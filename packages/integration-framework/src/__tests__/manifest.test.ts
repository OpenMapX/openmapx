import { describe, expect, it } from "vitest";
import { dataSourceSchema } from "../manifest.js";

const source = {
  sourceId: "de-test-cameras",
  name: "x",
  url: "https://x",
  license: "L",
  providerCountry: "DE",
  providerPrivacyUrl: "https://x/p",
};

const parse = (mediaHosts: unknown) => dataSourceSchema.safeParse({ ...source, mediaHosts });

describe("dataSourceSchema.mediaHosts", () => {
  it("accepts exact hosts, subdomain wildcards and host plus path prefix", () => {
    expect(
      parse([
        "weathercam.digitraffic.fi",
        "*.thb.gov.tw",
        "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/",
      ]).success,
    ).toBe(true);
  });

  it("is optional", () => {
    expect(dataSourceSchema.safeParse(source).success).toBe(true);
  });

  it.each([
    ["a scheme", "https://x"],
    ["a bare wildcard", "*"],
    ["a wildcard without a domain", "*."],
    ["a wildcard in the middle", "a.*.example.com"],
    ["a port", "example.com:8080"],
    ["an empty string", ""],
    ["a wildcard with a path", "*.example.com/images/"],
    ["whitespace", "exa mple.com"],
    ["a query", "example.com/a?b=1"],
    ["a wildcard over one label", "*.com"],
    ["a single-label host", "intranet"],
    ["an IPv4 literal", "10.0.0.5"],
    ["an IPv4 literal with a path", "169.254.169.254/latest/"],
    ["a short IPv4 literal", "127.1"],
    ["a hexadecimal IPv4 literal", "cam.0x7f"],
    ["a wildcard over an IPv4 literal", "*.0.0.1"],
    ["an IPv6 literal", "[::1]"],
    ["a bare IPv6 literal", "::1"],
    ["localhost", "localhost"],
    ["a wildcard over localhost", "*.localhost"],
    ["a localhost subdomain", "cam.localhost"],
    ["a dot-dot path segment", "cdn.example.com/images/../"],
    ["a dot path segment", "cdn.example.com/./images/"],
    ["an empty path segment", "cdn.example.com//images/"],
    ["a bare root path", "cdn.example.com/"],
    ["an encoded slash in the path", "cdn.example.com/a%2Fb/"],
    ["an encoded dot in the path", "cdn.example.com/%2e%2e/"],
    ["a path prefix not ending in a slash", "s3-eu-west-1.amazonaws.com/jamcams"],
    ["a wildcard over AWS", "*.amazonaws.com"],
    ["a wildcard over an AWS service domain", "*.s3.eu-west-1.amazonaws.com"],
    ["a wildcard over CloudFront", "*.cloudfront.net"],
    ["a wildcard over Google user content", "*.googleusercontent.com"],
    ["a wildcard over Azure blob storage", "*.blob.core.windows.net"],
    ["a wildcard over App Engine", "*.appspot.com"],
    ["a wildcard over Heroku", "*.herokuapp.com"],
    ["a wildcard over GitHub Pages", "*.github.io"],
    ["a wildcard over Azure web apps", "*.azurewebsites.net"],
    ["a wildcard over Cloudflare R2", "*.r2.dev"],
    ["a wildcard over Cloudflare Workers", "*.workers.dev"],
    ["a wildcard over Cloudflare Pages", "*.pages.dev"],
    ["a wildcard over Netlify", "*.netlify.app"],
    ["a wildcard over Vercel", "*.vercel.app"],
    ["a wildcard over a two-label public suffix", "*.co.uk"],
    ["a wildcard over another two-label public suffix", "*.com.au"],
    ["a wildcard over a government suffix", "*.gov.tw"],
  ])("rejects %s", (_name, entry) => {
    const result = parse([entry]);
    expect(result.success).toBe(false);
  });

  it("accepts an exact host on a shared provider and a wildcard below a public suffix", () => {
    expect(
      parse(["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/", "*.thb.gov.tw", "*.example.co.uk"])
        .success,
    ).toBe(true);
  });

  it("explains that a path prefix ends in a slash", () => {
    const result = parse(["s3-eu-west-1.amazonaws.com/jamcams"]);
    expect(JSON.stringify(result.error?.issues)).toContain("must end in /");
  });

  it("explains what an entry may look like", () => {
    const result = parse(["https://x"]);
    expect(JSON.stringify(result.error?.issues)).toContain("mediaHosts entry");
  });
});
