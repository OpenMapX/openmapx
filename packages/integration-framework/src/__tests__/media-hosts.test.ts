import { describe, expect, test } from "vitest";
import { matchesMediaHost, parseMediaHostEntry } from "../media-hosts.js";

describe("matchesMediaHost", () => {
  test("an exact host matches that host only, in any letter case", () => {
    const hosts = ["weathercam.digitraffic.fi"];
    expect(matchesMediaHost("https://weathercam.digitraffic.fi/C0150301.jpg", hosts)).toBe(true);
    expect(matchesMediaHost("http://WeatherCam.Digitraffic.FI/a.jpg", hosts)).toBe(true);
    expect(matchesMediaHost("https://cdn.weathercam.digitraffic.fi/a.jpg", hosts)).toBe(false);
    expect(matchesMediaHost("https://weathercam.digitraffic.fi.example.org/a.jpg", hosts)).toBe(
      false,
    );
    expect(matchesMediaHost("https://example.org/a.jpg", hosts)).toBe(false);
  });

  test("an entry is matched lower-cased too", () => {
    expect(matchesMediaHost("https://cctv.example.org/a.jpg", ["CCTV.Example.org"])).toBe(true);
  });

  test("a wildcard matches subdomains, never the domain itself", () => {
    const hosts = ["*.thb.gov.tw"];
    expect(matchesMediaHost("https://cctv1.thb.gov.tw/a.jpg", hosts)).toBe(true);
    expect(matchesMediaHost("https://a.b.thb.gov.tw/a.jpg", hosts)).toBe(true);
    expect(matchesMediaHost("https://thb.gov.tw/a.jpg", hosts)).toBe(false);
    expect(matchesMediaHost("https://evilthb.gov.tw/a.jpg", hosts)).toBe(false);
  });

  test("a path prefix admits only paths under it", () => {
    const hosts = ["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/"];
    expect(
      matchesMediaHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.jpg", hosts),
    ).toBe(true);
    expect(matchesMediaHost("https://s3-eu-west-1.amazonaws.com/other-bucket/a.jpg", hosts)).toBe(
      false,
    );
    expect(matchesMediaHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk", hosts)).toBe(
      false,
    );
    // Dot segments are resolved before the path is compared.
    expect(
      matchesMediaHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/../x/a.jpg", hosts),
    ).toBe(false);
  });

  test("refuses a non-default port, credentials, another scheme and a malformed URL", () => {
    const hosts = ["weathercam.digitraffic.fi"];
    expect(matchesMediaHost("https://weathercam.digitraffic.fi:8443/a.jpg", hosts)).toBe(false);
    expect(matchesMediaHost("https://weathercam.digitraffic.fi:443/a.jpg", hosts)).toBe(true);
    expect(matchesMediaHost("https://user:pw@weathercam.digitraffic.fi/a.jpg", hosts)).toBe(false);
    expect(matchesMediaHost("ftp://weathercam.digitraffic.fi/a.jpg", hosts)).toBe(false);
    expect(matchesMediaHost("not a url", hosts)).toBe(false);
  });

  test("an exact host on a shared hosting domain admits only paths under its prefix", () => {
    // Without a path the entry would admit every customer's bucket on the endpoint.
    for (const entry of ["s3-eu-west-1.amazonaws.com", "d1234.cloudfront.net", "r2.dev"]) {
      expect(parseMediaHostEntry(entry), entry).toBeNull();
    }
    expect(
      matchesMediaHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.jpg", [
        "s3-eu-west-1.amazonaws.com",
      ]),
    ).toBe(false);
    expect(parseMediaHostEntry("s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/")).toEqual({
      host: "s3-eu-west-1.amazonaws.com",
      wildcard: false,
      path: "/jamcams.tfl.gov.uk/",
    });
    // A host merely ending in the same letters is no shared domain.
    expect(parseMediaHostEntry("notamazonaws.com")).not.toBeNull();
  });

  test("no entries match nothing", () => {
    expect(matchesMediaHost("https://weathercam.digitraffic.fi/a.jpg", [])).toBe(false);
  });

  test("ignores an entry that could reach a loopback, private or wildcard-wide target", () => {
    const cases: Array<[url: string, entry: string]> = [
      ["https://example.com/a.jpg", "*.com"],
      ["https://127.0.0.1/a.jpg", "127.0.0.1"],
      ["https://10.0.0.5/a.jpg", "10.0.0.5"],
      ["https://169.254.169.254/latest/meta-data", "169.254.169.254/latest/"],
      ["https://localhost/a.jpg", "localhost"],
      ["https://cam.localhost/a.jpg", "*.localhost"],
      ["https://cam.localhost/a.jpg", "cam.localhost"],
      ["https://[::1]/a.jpg", "[::1]"],
    ];
    for (const [url, entry] of cases) {
      expect(matchesMediaHost(url, [entry]), entry).toBe(false);
    }
  });

  test("ignores a path prefix with dot segments or an empty segment", () => {
    for (const entry of [
      "s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/../",
      "s3-eu-west-1.amazonaws.com/./jamcams.tfl.gov.uk/",
      "s3-eu-west-1.amazonaws.com//jamcams.tfl.gov.uk/",
      "s3-eu-west-1.amazonaws.com/",
      "s3-eu-west-1.amazonaws.com/jamcams%2ftfl/",
    ]) {
      expect(
        matchesMediaHost("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/a.jpg", [entry]),
        entry,
      ).toBe(false);
    }
  });

  test("a path prefix is bounded by a whole segment", () => {
    const hosts = ["s3-eu-west-1.amazonaws.com/jamcams/"];
    expect(matchesMediaHost("https://s3-eu-west-1.amazonaws.com/jamcams/a.jpg", hosts)).toBe(true);
    expect(matchesMediaHost("https://s3-eu-west-1.amazonaws.com/jamcams-evil/a.jpg", hosts)).toBe(
      false,
    );
    // An entry without the closing slash would admit a sibling bucket, so it matches nothing.
    for (const url of [
      "https://s3-eu-west-1.amazonaws.com/jamcams-evil/a.jpg",
      "https://s3-eu-west-1.amazonaws.com/jamcams/a.jpg",
    ]) {
      expect(matchesMediaHost(url, ["s3-eu-west-1.amazonaws.com/jamcams"]), url).toBe(false);
    }
  });

  test("ignores a wildcard over a multi-tenant hosting domain or a public suffix", () => {
    for (const [url, entry] of [
      ["https://attacker-bucket.s3.amazonaws.com/a.jpg", "*.amazonaws.com"],
      ["https://d111111abcdef8.cloudfront.net/a.jpg", "*.cloudfront.net"],
      ["https://attacker.github.io/a.jpg", "*.github.io"],
      ["https://attacker.co.uk/a.jpg", "*.co.uk"],
    ]) {
      expect(matchesMediaHost(url, [entry]), entry).toBe(false);
    }
  });

  test("refuses an encoded separator or dot below a path prefix", () => {
    const hosts = ["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/"];
    for (const path of ["%2F..%2Fother/a.jpg", "%2e%2e/other/a.jpg", "..%5Cother/a.jpg"]) {
      expect(
        matchesMediaHost(`https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${path}`, hosts),
        path,
      ).toBe(false);
    }
  });
});
