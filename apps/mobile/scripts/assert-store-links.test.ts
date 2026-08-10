import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALLOWED_APPLINK_PATHS,
  checkAppleAssociation,
  checkAssetLinks,
  checkIdentities,
  type LinkFinding,
  MAX_ASSOCIATION_BYTES,
  type PublicSigningIdentities,
} from "./storeLinks";

/**
 * These files fail quietly in production: the OS fetches them once, decides,
 * and moves on. A typo costs a release, and nothing in the app reports it. So
 * the checks are written against the two mistakes that actually happen — a
 * placeholder that parses fine and verifies against nothing, and the Android
 * upload key standing in for Google's app-signing certificate.
 */

const REAL: PublicSigningIdentities = {
  apple: {
    teamId: "ABCDE12345",
    applicationIdentifier: "ABCDE12345.org.openmapx.app",
    bundleIdentifier: "org.openmapx.app",
  },
  google: {
    packageName: "org.openmapx.app",
    playAppSigningSha256:
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
  },
  origin: "https://openmapx.com",
  scheme: "openmapx",
};

const PLACEHOLDER: PublicSigningIdentities = {
  apple: {
    teamId: "TEAM_ID",
    applicationIdentifier: "TEAM_ID.org.openmapx.app",
    bundleIdentifier: "org.openmapx.app",
  },
  google: {
    packageName: "org.openmapx.app",
    playAppSigningSha256: "REPLACE_WITH_SHA256_FINGERPRINT",
  },
  origin: "https://openmapx.com",
  scheme: "openmapx",
};

const errors = (findings: LinkFinding[]) =>
  findings.filter((finding) => finding.severity === "error");
const pending = (findings: LinkFinding[]) =>
  findings.filter((finding) => finding.severity === "pending");

const aasa = (details: unknown, credentials = [REAL.apple.applicationIdentifier]) =>
  JSON.stringify({ applinks: { details }, webcredentials: { apps: credentials } });

const goodDetails = [
  {
    appIDs: [REAL.apple.applicationIdentifier],
    components: ALLOWED_APPLINK_PATHS.map((path) => ({ "/": path })),
  },
];

describe("checkIdentities", () => {
  it("accepts a complete real identity", () => {
    expect(checkIdentities(REAL)).toEqual([]);
  });

  it("reports placeholders as pending, not as errors", () => {
    const findings = checkIdentities(PLACEHOLDER);

    // Failing here would mean the check can never pass until an external step
    // happens, so it would simply be turned off.
    expect(errors(findings)).toEqual([]);
    expect(pending(findings)).toHaveLength(2);
  });

  it("rejects a team id that is not a team id", () => {
    const findings = checkIdentities({
      ...REAL,
      apple: { ...REAL.apple, teamId: "SHORT", applicationIdentifier: "SHORT.org.openmapx.app" },
    });

    expect(errors(findings)).toHaveLength(1);
  });

  it("rejects an application identifier that does not match its parts", () => {
    const findings = checkIdentities({
      ...REAL,
      apple: { ...REAL.apple, applicationIdentifier: "ABCDE12345.org.somebody.else" },
    });

    expect(errors(findings)[0].message).toContain("ABCDE12345.org.openmapx.app");
  });

  it("rejects the upload key standing in for the app-signing certificate", () => {
    const findings = checkIdentities({
      ...REAL,
      google: { ...REAL.google, uploadKeySha256: REAL.google.playAppSigningSha256 },
    });

    // Both are 64 hex characters, so nothing about the value gives this away —
    // and links signed this way never verify.
    expect(errors(findings)[0].message).toContain("never verify");
  });

  it("rejects a fingerprint that is not one", () => {
    const findings = checkIdentities({
      ...REAL,
      google: { ...REAL.google, playAppSigningSha256: "not-a-fingerprint" },
    });

    expect(errors(findings)).toHaveLength(1);
  });
});

describe("checkAppleAssociation", () => {
  it("accepts the approved paths", () => {
    expect(checkAppleAssociation(aasa(goodDetails), REAL)).toEqual([]);
  });

  it("accepts the older paths array", () => {
    const details = [{ appID: REAL.apple.applicationIdentifier, paths: ALLOWED_APPLINK_PATHS }];

    expect(checkAppleAssociation(aasa(details), REAL)).toEqual([]);
  });

  it("rejects a wildcard path", () => {
    const details = [{ appIDs: [REAL.apple.applicationIdentifier], components: [{ "/": "/*" }] }];

    // A link that opens an unreviewed screen is a link nobody checked.
    expect(errors(checkAppleAssociation(aasa(details), REAL))[0].message).toContain("wildcard");
  });

  it("rejects a path nobody approved", () => {
    const details = [
      { appIDs: [REAL.apple.applicationIdentifier], components: [{ "/": "/admin" }] },
    ];

    expect(errors(checkAppleAssociation(aasa(details), REAL))[0].message).toContain("/admin");
  });

  it("rejects another app claiming our links", () => {
    const details = [{ appIDs: ["ZZZZZ99999.org.somebody.else"], components: [{ "/": "/" }] }];

    expect(errors(checkAppleAssociation(aasa(details), REAL))).not.toEqual([]);
  });

  it("reports missing applinks details", () => {
    // The state this repository was actually in: valid JSON, passkeys declared,
    // and no HTTPS link would ever have opened the app.
    const findings = checkAppleAssociation(
      JSON.stringify({ webcredentials: { apps: [REAL.apple.applicationIdentifier] } }),
      REAL,
    );

    expect(errors(findings)[0].message).toContain("no HTTPS link will ever open the app");
  });

  it("requires webcredentials for passkeys", () => {
    const findings = checkAppleAssociation(aasa(goodDetails, []), REAL);

    expect(errors(findings)[0].message).toContain("passkeys");
  });

  it("rejects an oversize document", () => {
    const findings = checkAppleAssociation("x".repeat(MAX_ASSOCIATION_BYTES + 1), REAL);

    expect(errors(findings)[0].message).toContain("128 KiB");
  });

  it("rejects invalid JSON", () => {
    expect(errors(checkAppleAssociation("{not json", REAL))).toHaveLength(1);
  });
});

describe("checkAssetLinks", () => {
  const statement = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: REAL.google.packageName,
          sha256_cert_fingerprints: [REAL.google.playAppSigningSha256],
        },
        ...overrides,
      },
    ]);

  it("accepts a correct statement", () => {
    expect(checkAssetLinks(statement(), REAL)).toEqual([]);
  });

  it("requires handle_all_urls", () => {
    const findings = checkAssetLinks(
      statement({ relation: ["delegate_permission/common.get_login_creds"] }),
      REAL,
    );

    expect(errors(findings)[0].message).toContain("handle_all_urls");
  });

  it("rejects another package being granted our links", () => {
    const raw = JSON.stringify([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.somebody.else",
          sha256_cert_fingerprints: [REAL.google.playAppSigningSha256],
        },
      },
    ]);

    // A decision nobody made on purpose.
    expect(
      errors(checkAssetLinks(raw, REAL)).some((f) => f.message.includes("com.somebody.else")),
    ).toBe(true);
  });

  it("rejects a fingerprint that is not the recorded one", () => {
    const raw = JSON.stringify([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: REAL.google.packageName,
          sha256_cert_fingerprints: [
            "11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99:00:11:22",
          ],
        },
      },
    ]);

    expect(errors(checkAssetLinks(raw, REAL))[0].message).toContain("does not match");
  });

  it("reports a placeholder fingerprint as pending", () => {
    const raw = JSON.stringify([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: PLACEHOLDER.google.packageName,
          sha256_cert_fingerprints: ["REPLACE_WITH_SHA256_FINGERPRINT"],
        },
      },
    ]);

    expect(errors(checkAssetLinks(raw, PLACEHOLDER))).toEqual([]);
    expect(pending(checkAssetLinks(raw, PLACEHOLDER))).toHaveLength(1);
  });

  it("rejects a non-array document", () => {
    expect(errors(checkAssetLinks("{}", REAL))[0].message).toContain("array");
  });
});

describe("the committed association files", () => {
  const base = resolve(import.meta.dirname, "../../../services/well-known/config/html");
  const identities = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../release/public-signing-identities.json"), "utf8"),
  ) as PublicSigningIdentities;

  it("declare the approved paths and nothing else", () => {
    const raw = readFileSync(resolve(base, "apple-app-site-association"), "utf8");

    expect(errors(checkAppleAssociation(raw, identities))).toEqual([]);
  });

  it("name this package and no other", () => {
    const raw = readFileSync(resolve(base, "assetlinks.json"), "utf8");

    expect(errors(checkAssetLinks(raw, identities))).toEqual([]);
  });

  it("are still waiting on identities nobody has issued", () => {
    // The honest state before store enrollment, recorded so it cannot be
    // mistaken for a verified configuration.
    expect(pending(checkIdentities(identities)).length).toBeGreaterThan(0);
  });
});
