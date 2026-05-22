import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttributionIndex } from "../index.js";
import type { ManifestDataSource, MotisLicenseEntry } from "../types.js";

const LICENSE_FIXTURE: MotisLicenseEntry[] = [
  {
    country_code: "DE",
    spdx_license_identifier: "CC0-1.0",
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    source: "https://example.com/delfi.zip",
    filename: "de_DELFI.gtfs.zip",
    human_name: "DELFI Germany",
    publisher: { name: "DELFI e.V.", url: "https://delfi.de/" },
  },
  {
    country_code: "CH",
    spdx_license_identifier: "OPEN-DATA-CH",
    license_url: "https://opentransportdata.swiss/license",
    source: "https://opentransportdata.swiss/gtfs.zip",
    filename: "ch_SBB.gtfs.zip",
    human_name: "SBB Switzerland",
    publisher: { name: "SBB", url: "https://www.sbb.ch/" },
  },
];

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let tmpDir: string;
let licenseFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "attribution-index-"));
  licenseFile = join(tmpDir, "license.json");
  writeFileSync(licenseFile, JSON.stringify(LICENSE_FIXTURE), "utf-8");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("AttributionIndex", () => {
  it("loads MOTIS license entries via getById and getForMotisFile", async () => {
    const idx = await AttributionIndex.init({
      log: noopLog,
      motisLicenseFile: licenseFile,
      enableMtimePoller: false,
    });

    const delfi = idx.getById("de_DELFI");
    expect(delfi).toBeDefined();
    expect(delfi?.name).toBe("DELFI Germany");
    expect(delfi?.publisher?.name).toBe("DELFI e.V.");
    expect(delfi?.source).toBe("motis-license");

    const sbb = idx.getForMotisFile("ch_SBB.gtfs.zip");
    expect(sbb).toBeDefined();
    expect(sbb?.sourceId).toBe("ch_SBB");
    expect(sbb?.spdxLicense).toBe("OPEN-DATA-CH");

    idx.close();
  });

  it("merges manifest sources with license sources and prefers manifest on collision", async () => {
    const manifests: ManifestDataSource[] = [
      {
        sourceId: "de_DELFI",
        name: "DELFI (curated)",
        url: "https://delfi.example/",
        license: "CC0-1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "DELFI e.V. — curated",
        providerCountry: "de",
        providerPrivacyUrl: "https://delfi.example/privacy",
      },
      {
        sourceId: "extra-source",
        name: "Manifest-only",
        url: "https://manifest-only.example/",
        license: "MIT",
        providerCountry: "us",
        providerPrivacyUrl: "https://manifest-only.example/privacy",
      },
    ];
    const idx = await AttributionIndex.init({
      log: noopLog,
      motisLicenseFile: licenseFile,
      integrationManifests: manifests,
      enableMtimePoller: false,
    });

    const delfi = idx.getById("de_DELFI");
    expect(delfi?.source).toBe("integration-manifest");
    expect(delfi?.name).toBe("DELFI (curated)");
    expect(delfi?.attributionText).toBe("DELFI e.V. — curated");

    const extra = idx.getById("extra-source");
    expect(extra?.source).toBe("integration-manifest");
    expect(extra?.name).toBe("Manifest-only");

    // MOTIS-only entry remains motis-license sourced
    const sbb = idx.getById("ch_SBB");
    expect(sbb?.source).toBe("motis-license");

    idx.close();
  });

  it("dedupAndOrder produces stable group ordering and deduplicates", async () => {
    const manifests: ManifestDataSource[] = [
      {
        sourceId: "alpha-manifest",
        name: "Alpha",
        license: "MIT",
        providerCountry: "us",
        providerPrivacyUrl: "https://alpha.example/privacy",
      },
      {
        sourceId: "beta-manifest",
        name: "Beta",
        license: "MIT",
        providerCountry: "us",
        providerPrivacyUrl: "https://beta.example/privacy",
      },
    ];
    const idx = await AttributionIndex.init({
      log: noopLog,
      motisLicenseFile: licenseFile,
      integrationManifests: manifests,
      enableMtimePoller: false,
    });

    const inputs: Attribution[] = [
      { sourceId: "ch_SBB", name: "SBB (from caller)" },
      { sourceId: "beta-manifest", name: "Beta (from caller)" },
      { sourceId: "de_DELFI", name: "DELFI (from caller)" },
      { sourceId: "alpha-manifest", name: "Alpha (from caller)" },
      { sourceId: "ch_SBB", name: "SBB duplicate" },
      { sourceId: "zeta-unknown", name: "Zeta (unknown source)" },
    ];

    const ordered = idx.dedupAndOrder(inputs);
    const ids = ordered.map((a) => a.sourceId);
    // Manifest group (alphabetical) first, then motis-license (alphabetical),
    // then unknown (alphabetical). Duplicates removed.
    expect(ids).toEqual(["alpha-manifest", "beta-manifest", "ch_SBB", "de_DELFI", "zeta-unknown"]);

    // Unknown sourceId passes through with its caller-provided name.
    const zeta = ordered.find((a) => a.sourceId === "zeta-unknown");
    expect(zeta?.name).toBe("Zeta (unknown source)");

    // Manifest entries come from the curated map (not the input shape).
    const alpha = ordered.find((a) => a.sourceId === "alpha-manifest");
    expect(alpha?.name).toBe("Alpha");

    idx.close();
  });

  it("reload picks up an mtime change to license.json", async () => {
    const idx = await AttributionIndex.init({
      log: noopLog,
      motisLicenseFile: licenseFile,
      enableMtimePoller: false,
    });

    expect(idx.getById("de_DELFI")).toBeDefined();
    expect(idx.getById("new_feed")).toBeUndefined();

    const updatedFixture: MotisLicenseEntry[] = [
      ...LICENSE_FIXTURE,
      {
        filename: "new_feed.gtfs.zip",
        human_name: "Newly Added Feed",
        publisher: { name: "Newly Added Authority", url: "https://new.example/" },
        spdx_license_identifier: "CC-BY-4.0",
      },
    ];
    writeFileSync(licenseFile, JSON.stringify(updatedFixture), "utf-8");
    // bump mtime explicitly so the test isn't sensitive to FS timestamp resolution
    const future = new Date(Date.now() + 10_000);
    utimesSync(licenseFile, future, future);

    await idx.reload();

    const newFeed = idx.getById("new_feed");
    expect(newFeed).toBeDefined();
    expect(newFeed?.name).toBe("Newly Added Feed");

    idx.close();
  });

  it("health returns sane counts", async () => {
    const manifests: ManifestDataSource[] = [
      {
        sourceId: "manifest-1",
        name: "Manifest 1",
        license: "MIT",
        providerCountry: "us",
        providerPrivacyUrl: "https://m1.example/privacy",
      },
    ];
    const idx = await AttributionIndex.init({
      log: noopLog,
      motisLicenseFile: licenseFile,
      integrationManifests: manifests,
      enableMtimePoller: false,
    });

    const h = idx.health();
    expect(h.sources).toBe(3);
    expect(h.motisFeeds).toBe(2);
    expect(h.manifestSources).toBe(1);
    expect(typeof h.loadedAt).toBe("string");
    expect(h.loadedAt.length).toBeGreaterThan(0);

    idx.close();
  });
});
