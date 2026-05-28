import { describe, expect, it } from "vitest";
import { licenseUrlForSpdx, normalizeLicenseToSpdx, resolveLicenseLink } from "../src/license.js";

describe("normalizeLicenseToSpdx", () => {
  it("passes through known SPDX ids (case-insensitive)", () => {
    expect(normalizeLicenseToSpdx("ODbL-1.0")).toBe("ODbL-1.0");
    expect(normalizeLicenseToSpdx("cc-by-4.0")).toBe("CC-BY-4.0");
  });

  it("maps verbose German labels to DL-DE-BY-2.0", () => {
    expect(normalizeLicenseToSpdx("Datenlizenz Deutschland – Namensnennung – Version 2.0")).toBe(
      "DL-DE-BY-2.0",
    );
    expect(normalizeLicenseToSpdx("dl-de/by-2-0")).toBe("DL-DE-BY-2.0");
  });

  it("maps Creative Commons long labels", () => {
    expect(
      normalizeLicenseToSpdx("Creative Commons Namensnennung - 4.0 International (CC-BY 4.0)"),
    ).toBe("CC-BY-4.0");
    expect(normalizeLicenseToSpdx("CC 0 1.0")).toBe("CC0-1.0");
  });

  it("derives SPDX from a license URL", () => {
    expect(normalizeLicenseToSpdx("https://creativecommons.org/licenses/by-sa/4.0/")).toBe(
      "CC-BY-SA-4.0",
    );
    expect(normalizeLicenseToSpdx("https://opendatacommons.org/licenses/odbl/1-0/")).toBe(
      "ODbL-1.0",
    );
  });

  it("returns undefined for empty or unknown input", () => {
    expect(normalizeLicenseToSpdx(undefined)).toBeUndefined();
    expect(normalizeLicenseToSpdx("")).toBeUndefined();
    expect(normalizeLicenseToSpdx("Some Bespoke Terms")).toBeUndefined();
  });
});

describe("licenseUrlForSpdx", () => {
  it("returns the canonical URL from the SPDX registry", () => {
    expect(licenseUrlForSpdx("DL-DE-BY-2.0")).toBe("https://www.govdata.de/dl-de/by-2-0");
    expect(licenseUrlForSpdx("CC0-1.0")).toBe(
      "https://creativecommons.org/publicdomain/zero/1.0/legalcode",
    );
  });

  it("resolves case-insensitively", () => {
    expect(licenseUrlForSpdx("odbl-1.0")).toBe(licenseUrlForSpdx("ODbL-1.0"));
  });

  it("returns undefined for non-SPDX strings", () => {
    expect(licenseUrlForSpdx("Bespoke Operator Terms")).toBeUndefined();
    expect(licenseUrlForSpdx(undefined)).toBeUndefined();
  });
});

describe("resolveLicenseLink", () => {
  it("prefers an explicit licenseUrl over the derived one", () => {
    expect(
      resolveLicenseLink({ license: "ODbL-1.0", licenseUrl: "https://example.com/terms" }),
    ).toEqual({ label: "ODbL-1.0", url: "https://example.com/terms" });
  });

  it("derives the SPDX id and URL from a verbose license label", () => {
    expect(
      resolveLicenseLink({ license: "Datenlizenz Deutschland – Namensnennung – Version 2.0" }),
    ).toEqual({ label: "DL-DE-BY-2.0", url: "https://www.govdata.de/dl-de/by-2-0" });
  });

  it("keeps the raw label when no SPDX match but still returns a url-less link", () => {
    expect(resolveLicenseLink({ license: "Bespoke Operator Terms" })).toEqual({
      label: "Bespoke Operator Terms",
    });
  });

  it("returns null when nothing is provided", () => {
    expect(resolveLicenseLink({})).toBeNull();
  });

  it("falls back to a generic label when only a url is given", () => {
    expect(resolveLicenseLink({ licenseUrl: "https://example.com/x" })).toEqual({
      label: "License",
      url: "https://example.com/x",
    });
  });
});
