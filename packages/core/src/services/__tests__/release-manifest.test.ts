import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  canonicalReleaseManifest,
  parseReleaseComposeSelection,
  parseReleaseManifest,
  type ReleaseManifest,
  releaseChannel,
  renderReleaseCompose,
  transitousToolsImageFromReleaseCompose,
  writeReleaseComposeArtifacts,
} from "../release-manifest";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  release: "abc123",
  images: {
    api: `ghcr.io/openmapx/api@${digest("a")}`,
    web: `ghcr.io/openmapx/web@${digest("b")}`,
    "data-manager": `ghcr.io/openmapx/data-manager@${digest("c")}`,
    "ops-agent": `ghcr.io/openmapx/ops-agent@${digest("d")}`,
    "privacy-backup": `ghcr.io/openmapx/privacy-backup@${digest("9")}`,
    "transitous-runner": `ghcr.io/openmapx/transitous-runner@${digest("e")}`,
    "transitous-tools": `ghcr.io/openmapx/transitous-tools@${digest("f")}`,
  },
  privacyReleaseValidation: {
    version: 1,
    sourceBuildFingerprint: "2".repeat(64),
    validatedAt: "2026-09-05T12:00:00.000Z",
    checks: {
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    },
  },
};

describe("shared release manifest", () => {
  it("accepts a run-qualified mixed release and renders its exact reused digests", () => {
    const mixed = {
      ...manifest,
      release: `${"a".repeat(40)}-123-2`,
      buildMetadata: {
        version: 1,
        images: {
          api: {
            sourceRevision: "b".repeat(40),
            inputHash: "c".repeat(64),
            builtAt: "2026-09-05T12:00:00.000Z",
          },
        },
      },
    };
    const parsed = parseReleaseManifest(JSON.stringify(mixed));
    expect(parsed).toEqual(mixed);
    const overlay = renderReleaseCompose(parsed);
    expect(overlay).toContain(`image: ${manifest.images.api}`);
    expect(overlay).toContain(`image: ${manifest.images["ops-agent"]}`);
  });

  it("parses an approved manifest and rejects tag references", () => {
    expect(parseReleaseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() =>
      parseReleaseManifest(
        JSON.stringify({
          ...manifest,
          images: { ...manifest.images, api: "ghcr.io/openmapx/api:latest" },
        }),
      ),
    ).toThrow(/images\.api/);
    expect(() =>
      parseReleaseManifest(
        JSON.stringify({
          ...manifest,
          images: {
            ...manifest.images,
            "privacy-backup": "ghcr.io/openmapx/privacy-backup:latest",
          },
        }),
      ),
    ).toThrow(/images\.privacy-backup/);
  });

  it("round-trips the transitous-tools pin through the rendered overlay", () => {
    const overlay = renderReleaseCompose(manifest);
    expect(transitousToolsImageFromReleaseCompose(overlay)).toBe(
      manifest.images["transitous-tools"],
    );
    expect(transitousToolsImageFromReleaseCompose("services: {}\n")).toBeNull();
    expect(overlay).toContain(`image: ${manifest.images["ops-agent"]}`);
    expect(overlay).toContain(`image: ${manifest.images["transitous-runner"]}`);
  });

  it("rejects missing or unvalidated privacy release evidence", () => {
    const { privacyReleaseValidation: _missing, ...withoutEvidence } = manifest;
    expect(() => parseReleaseManifest(JSON.stringify(withoutEvidence))).toThrow(
      /privacyReleaseValidation/,
    );
    expect(() =>
      parseReleaseManifest(
        JSON.stringify({
          ...manifest,
          privacyReleaseValidation: {
            ...manifest.privacyReleaseValidation,
            checks: {
              ...manifest.privacyReleaseValidation.checks,
              policyConsistent: false,
            },
          },
        }),
      ),
    ).toThrow(/privacyReleaseValidation\.checks\.policyConsistent/);
  });

  it("rejects evidence the API would reject instead of mounting unusable JSON", () => {
    for (const privacyReleaseValidation of [
      { ...manifest.privacyReleaseValidation, unexpected: true },
      {
        ...manifest.privacyReleaseValidation,
        checks: { ...manifest.privacyReleaseValidation.checks, unexpected: true },
      },
      { ...manifest.privacyReleaseValidation, validatedAt: "2026-02-31T12:00:00Z" },
    ]) {
      expect(() =>
        parseReleaseManifest(JSON.stringify({ ...manifest, privacyReleaseValidation })),
      ).toThrow(/privacyReleaseValidation/);
    }
  });

  it("renders the exact collector pin and validation evidence for the API and ops agent", () => {
    const overlay = load(renderReleaseCompose(manifest)) as {
      services: Record<string, { environment?: Record<string, string>; configs?: unknown[] }>;
      configs: Record<string, { file: string }>;
    };
    const collector = manifest.images["privacy-backup"];
    expect(overlay.services["app-api"]?.environment).toMatchObject({
      OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE: collector,
      PRIVACY_EXPORT_VALIDATION_EVIDENCE_FILE:
        "$" +
        "{PRIVACY_EXPORT_VALIDATION_EVIDENCE_FILE:-/run/openmapx/privacy-release-validation.json}",
    });
    expect(overlay.services["ops-agent"]?.environment).toMatchObject({
      OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED: "$" + "{OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED:-true}",
      OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE: collector,
    });
    expect(overlay.services["app-api"]?.configs).toEqual([
      {
        source: "privacy-release-validation",
        target: "/run/openmapx/privacy-release-validation.json",
      },
    ]);
    expect(overlay.configs["privacy-release-validation"]).toEqual({
      file: "./.release-evidence/privacy-release-validation-59ce9957109148ecc7d47d1179863822a181e27293e188aa365b7fa787010cb2.json",
    });
  });

  it("publishes content-addressed evidence before an atomic release overlay", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-release-artifacts-"));
    try {
      const overlayPath = join(root, "docker-compose.release.yml");
      const result = writeReleaseComposeArtifacts(manifest, overlayPath);
      expect(result).toEqual({
        overlayPath,
        evidencePath: join(
          root,
          ".release-evidence",
          "privacy-release-validation-59ce9957109148ecc7d47d1179863822a181e27293e188aa365b7fa787010cb2.json",
        ),
      });
      expect(JSON.parse(readFileSync(result.evidencePath, "utf8"))).toEqual(
        manifest.privacyReleaseValidation,
      );
      expect(lstatSync(result.evidencePath).mode & 0o777).toBe(0o444);
      expect(lstatSync(join(root, ".release-evidence")).mode & 0o777).toBe(0o700);
      expect(readFileSync(overlayPath, "utf8")).toBe(renderReleaseCompose(manifest));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps release evidence readable by the fixed API UID under a restrictive umask", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-release-artifacts-"));
    const previousUmask = process.umask(0o077);
    try {
      const result = writeReleaseComposeArtifacts(
        manifest,
        join(root, "docker-compose.release.yml"),
      );
      expect(lstatSync(result.evidencePath).mode & 0o777).toBe(0o444);
    } finally {
      process.umask(previousUmask);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["corrupt", "symlink"] as const)(
    "refuses %s existing evidence without replacing the active release artifacts",
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), "openmapx-release-artifacts-"));
      try {
        const overlayPath = join(root, "docker-compose.release.yml");
        const active = writeReleaseComposeArtifacts(manifest, overlayPath);
        const activeOverlay = readFileSync(overlayPath, "utf8");
        const activeEvidence = readFileSync(active.evidencePath, "utf8");
        const next = {
          ...manifest,
          release: "def456",
          privacyReleaseValidation: {
            ...manifest.privacyReleaseValidation,
            validatedAt: "2026-09-06T12:00:00.000Z",
          },
        };
        const nextCompose = load(renderReleaseCompose(next)) as {
          configs: { "privacy-release-validation": { file: string } };
        };
        const nextEvidencePath = join(root, nextCompose.configs["privacy-release-validation"].file);
        if (kind === "corrupt") {
          writeFileSync(nextEvidencePath, "{}\n", { mode: 0o444 });
          chmodSync(nextEvidencePath, 0o444);
        } else {
          symlinkSync(active.evidencePath, nextEvidencePath);
        }

        expect(() => writeReleaseComposeArtifacts(next, overlayPath)).toThrow(
          /validation evidence is unsafe/,
        );
        expect(readFileSync(overlayPath, "utf8")).toBe(activeOverlay);
        expect(readFileSync(active.evidencePath, "utf8")).toBe(activeEvidence);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("retains prior evidence so the exact previous overlay still resolves after a switch", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-release-artifacts-"));
    try {
      const overlayPath = join(root, "docker-compose.release.yml");
      const first = writeReleaseComposeArtifacts(manifest, overlayPath);
      const firstOverlay = readFileSync(overlayPath, "utf8");
      const next = {
        ...manifest,
        release: "def456",
        privacyReleaseValidation: {
          ...manifest.privacyReleaseValidation,
          validatedAt: "2026-09-06T12:00:00.000Z",
        },
      };
      const second = writeReleaseComposeArtifacts(next, overlayPath);
      expect(second.evidencePath).not.toBe(first.evidencePath);
      expect(JSON.parse(readFileSync(first.evidencePath, "utf8"))).toEqual(
        manifest.privacyReleaseValidation,
      );
      expect(JSON.parse(readFileSync(second.evidencePath, "utf8"))).toEqual(
        next.privacyReleaseValidation,
      );

      const oldCompose = load(firstOverlay) as {
        configs: { "privacy-release-validation": { file: string } };
      };
      const oldEvidencePath = join(root, oldCompose.configs["privacy-release-validation"].file);
      expect(oldEvidencePath).toBe(first.evidencePath);
      expect(JSON.parse(readFileSync(oldEvidencePath, "utf8"))).toEqual(
        manifest.privacyReleaseValidation,
      );
      expect(firstOverlay).toBe(renderReleaseCompose(manifest));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("release channel", () => {
  it("defaults to the OpenMapX registry and derives the approved prefix from an override", () => {
    expect(releaseChannel(undefined)).toEqual({
      kind: "enabled",
      manifestImage: "ghcr.io/openmapx/release-manifest:latest",
      imagePrefix: "ghcr.io/openmapx",
    });
    expect(releaseChannel("registry.example.org/fork/release-manifest:stable")).toEqual({
      kind: "enabled",
      manifestImage: "registry.example.org/fork/release-manifest:stable",
      imagePrefix: "registry.example.org/fork",
    });
    expect(releaseChannel("")).toEqual({ kind: "disabled" });
    expect(() => releaseChannel("release-manifest")).toThrow(/registry/);
  });

  it("validates manifest images against the configured prefix", () => {
    const forked = {
      ...manifest,
      images: Object.fromEntries(
        Object.entries(manifest.images).map(([name, image]) => [
          name,
          image.replace("ghcr.io/openmapx", "registry.example.org/fork"),
        ]),
      ),
    };
    expect(parseReleaseManifest(JSON.stringify(forked), "registry.example.org/fork")).toEqual(
      forked,
    );
    expect(() => parseReleaseManifest(JSON.stringify(forked))).toThrow(/ghcr\.io\/openmapx/);
    expect(() =>
      parseReleaseManifest(JSON.stringify(manifest), "registry.example.org/fork"),
    ).toThrow(/not an approved/);
  });
});

describe("release lockfile image contract and selection", () => {
  it.each([`ghcr.io/openmapx/docs@${digest("1")}`, "ghcr.io/openmapx/docs:latest"])(
    "strips unrelated image fields from parsed and canonical releases (%s)",
    (docs) => {
      const input = { ...manifest, images: { ...manifest.images, docs, unrelated: null } };
      expect(parseReleaseManifest(JSON.stringify(input))).toEqual(manifest);
      expect(canonicalReleaseManifest(input)).toBe(JSON.stringify(manifest));
    },
  );

  it("round trips selected identity and seven images, including quoted release IDs", () => {
    const selected = { ...manifest, release: 'release: "test"' };
    const images = manifest.images;
    const rendered = renderReleaseCompose(selected);
    expect(parseReleaseComposeSelection(rendered)).toEqual({ release: selected.release, images });
    expect(rendered).not.toContain("ghcr.io/openmapx/docs");
  });

  it("reads legacy service pins without inventing a release identity", () => {
    expect(
      parseReleaseComposeSelection(`services:
  app-api:
    image: ${manifest.images.api}
`),
    ).toEqual({
      release: null,
      images: { api: manifest.images.api },
    });
    expect(() => parseReleaseComposeSelection("services: [")).toThrow();
    expect(() => parseReleaseComposeSelection("hello")).toThrow();
  });
});

it("does not attribute a modified service pin to stale release metadata", () => {
  const rendered = renderReleaseCompose(manifest).replace(
    `image: ${manifest.images.api}`,
    `image: ghcr.io/openmapx/api@${digest("0")}`,
  );
  const selected = parseReleaseComposeSelection(rendered);
  expect(selected.release).toBeNull();
  expect(selected.images.api).toBe(`ghcr.io/openmapx/api@${digest("0")}`);
});

it.each(["app-api", "ops-agent"])(
  "reports unknown helper selection when %s disagrees with its mirrored pin",
  (serviceId) => {
    const rendered = load(renderReleaseCompose(manifest)) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    rendered.services[serviceId].environment.OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE =
      `ghcr.io/openmapx/privacy-backup@${digest("0")}`;
    const selected = parseReleaseComposeSelection(JSON.stringify(rendered));
    expect(selected.release).toBeNull();
    expect(selected.images["privacy-backup"]).toBeUndefined();
    expect(selected.images.api).toBe(manifest.images.api);
    expect(selected.images["transitous-tools"]).toBe(manifest.images["transitous-tools"]);
  },
);

it("does not claim a complete release when a mirrored helper pin is absent", () => {
  const rendered = load(renderReleaseCompose(manifest)) as {
    services: Record<string, { environment: Record<string, string> }>;
  };
  delete rendered.services["app-api"].environment.OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE;
  const selected = parseReleaseComposeSelection(JSON.stringify(rendered));
  expect(selected.release).toBeNull();
  expect(selected.images["privacy-backup"]).toBeUndefined();
});
