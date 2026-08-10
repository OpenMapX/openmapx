/**
 * Validating the two files that make verified links work.
 *
 * An Apple App Site Association file and an Android assetlinks file are the only
 * things standing between "tapping an openmapx.com link opens the app" and
 * "tapping it opens a browser, silently, forever". They fail quietly by design:
 * the OS fetches them once, decides, and moves on, so a typo costs a release.
 *
 * Two failure modes matter more than malformed JSON.
 *
 * The first is shipping a placeholder. `TEAM_ID.org.openmapx.app` parses fine
 * and verifies against nothing. Placeholders are therefore reported as their own
 * outcome — "not yet issued" — rather than as a pass or an ordinary error.
 *
 * The second is the Android upload key. Play re-signs the delivered app with
 * Google's own certificate, so assetlinks must carry *that* fingerprint. Using
 * the upload key's is the most common way to ship links that never verify, and
 * both are 64 hex characters, so nothing about the value itself gives it away.
 */

export interface PublicSigningIdentities {
  status?: string;
  apple: { teamId: string; applicationIdentifier: string; bundleIdentifier: string };
  google: { packageName: string; playAppSigningSha256: string; uploadKeySha256?: string | null };
  origin: string;
  scheme: string;
}

export type Severity = "error" | "pending";

export interface LinkFinding {
  file: "apple-app-site-association" | "assetlinks.json" | "public-signing-identities.json";
  severity: Severity;
  message: string;
}

/** Anything longer is not an association file; the OS also refuses to fetch it. */
export const MAX_ASSOCIATION_BYTES = 128 * 1024;

/** Paths the app is willing to claim. Everything else stays a web link. */
export const ALLOWED_APPLINK_PATHS = ["/", "/navigation/active", "/mobile-auth"];

const PLACEHOLDER_MARKERS = ["TEAM_ID", "REPLACE_", "EXAMPLE", "XXXX", "CHANGEME"];
const SHA256_FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i;
const BARE_SHA256 = /^[0-9a-f]{64}$/i;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_MARKERS.some((marker) => value.toUpperCase().includes(marker));
}

/**
 * Checks the identity file itself.
 *
 * Runs first, because every other check compares against these values: a
 * placeholder here would otherwise be reported once per association file, which
 * reads like three problems rather than one unfinished step.
 */
export function checkIdentities(identities: PublicSigningIdentities): LinkFinding[] {
  const findings: LinkFinding[] = [];
  const file = "public-signing-identities.json" as const;

  if (isPlaceholder(identities.apple.teamId)) {
    findings.push({
      file,
      severity: "pending",
      message: "Apple Team ID has not been issued yet (enrollment is an external step)",
    });
  } else if (!/^[A-Z0-9]{10}$/.test(identities.apple.teamId)) {
    findings.push({
      file,
      severity: "error",
      message: `Apple Team ID ${identities.apple.teamId} is not a ten-character team identifier`,
    });
  }

  const expectedAppId = `${identities.apple.teamId}.${identities.apple.bundleIdentifier}`;
  if (identities.apple.applicationIdentifier !== expectedAppId) {
    findings.push({
      file,
      severity: "error",
      message: `applicationIdentifier should be ${expectedAppId}`,
    });
  }

  const fingerprint = identities.google.playAppSigningSha256;
  if (isPlaceholder(fingerprint)) {
    findings.push({
      file,
      severity: "pending",
      message: "Play app-signing certificate fingerprint has not been issued yet",
    });
  } else if (!SHA256_FINGERPRINT.test(fingerprint) && !BARE_SHA256.test(fingerprint)) {
    findings.push({
      file,
      severity: "error",
      message: "Play app-signing fingerprint is not a SHA-256 certificate fingerprint",
    });
  } else if (
    identities.google.uploadKeySha256 &&
    identities.google.uploadKeySha256.replace(/:/g, "").toLowerCase() ===
      fingerprint.replace(/:/g, "").toLowerCase()
  ) {
    // Both are 64 hex characters; nothing about the value gives this away.
    findings.push({
      file,
      severity: "error",
      message:
        "assetlinks would carry the upload key's fingerprint, not Google's app-signing certificate — links signed this way never verify",
    });
  }

  return findings;
}

/** Checks the Apple App Site Association document. */
export function checkAppleAssociation(
  raw: string,
  identities: PublicSigningIdentities,
): LinkFinding[] {
  const findings: LinkFinding[] = [];
  const file = "apple-app-site-association" as const;

  if (Buffer.byteLength(raw, "utf8") > MAX_ASSOCIATION_BYTES) {
    findings.push({ file, severity: "error", message: "larger than 128 KiB" });
    return findings;
  }

  let document: {
    applinks?: {
      details?: { appIDs?: string[]; appID?: string; components?: unknown[]; paths?: unknown[] }[];
    };
    webcredentials?: { apps?: string[] };
  };
  try {
    document = JSON.parse(raw);
  } catch {
    findings.push({ file, severity: "error", message: "is not valid JSON" });
    return findings;
  }

  const expectedAppId = identities.apple.applicationIdentifier;
  const pending = isPlaceholder(expectedAppId);

  const credentialApps = document.webcredentials?.apps ?? [];
  if (!credentialApps.includes(expectedAppId)) {
    findings.push({
      file,
      severity: pending ? "pending" : "error",
      message: `webcredentials.apps must contain ${expectedAppId} for passkeys to work`,
    });
  }

  const details = document.applinks?.details ?? [];
  if (details.length === 0) {
    findings.push({
      file,
      severity: pending ? "pending" : "error",
      message: "applinks.details is absent, so no HTTPS link will ever open the app",
    });
  }

  for (const detail of details) {
    const appIds = detail.appIDs ?? (detail.appID ? [detail.appID] : []);
    for (const appId of appIds) {
      if (appId !== expectedAppId) {
        findings.push({
          file,
          severity: isPlaceholder(appId) ? "pending" : "error",
          message: `applinks names ${appId}, which is not this app`,
        });
      }
    }

    const claimed = readClaimedPaths(detail);
    for (const path of claimed) {
      if (path.includes("*")) {
        findings.push({
          file,
          severity: "error",
          message: `applinks claims the wildcard path ${path}; a link that opens an unreviewed screen is a link nobody checked`,
        });
        continue;
      }
      if (!ALLOWED_APPLINK_PATHS.includes(path)) {
        findings.push({
          file,
          severity: "error",
          message: `applinks claims ${path}, which is not one of the approved paths`,
        });
      }
    }
  }

  return findings;
}

/** Both the modern `components` form and the older `paths` array. */
function readClaimedPaths(detail: { components?: unknown[]; paths?: unknown[] }): string[] {
  const paths: string[] = [];
  for (const component of detail.components ?? []) {
    const value = (component as { "/"?: unknown })["/"];
    if (typeof value === "string") paths.push(value);
  }
  for (const path of detail.paths ?? []) {
    if (typeof path === "string") paths.push(path);
  }
  return paths;
}

/** Checks the Android Digital Asset Links document. */
export function checkAssetLinks(raw: string, identities: PublicSigningIdentities): LinkFinding[] {
  const findings: LinkFinding[] = [];
  const file = "assetlinks.json" as const;

  if (Buffer.byteLength(raw, "utf8") > MAX_ASSOCIATION_BYTES) {
    findings.push({ file, severity: "error", message: "larger than 128 KiB" });
    return findings;
  }

  let statements: {
    relation?: string[];
    target?: { namespace?: string; package_name?: string; sha256_cert_fingerprints?: string[] };
  }[];
  try {
    statements = JSON.parse(raw);
  } catch {
    findings.push({ file, severity: "error", message: "is not valid JSON" });
    return findings;
  }

  if (!Array.isArray(statements)) {
    findings.push({ file, severity: "error", message: "must be an array of statements" });
    return findings;
  }

  const expectedFingerprint = identities.google.playAppSigningSha256;
  const pending = isPlaceholder(expectedFingerprint);

  const forThisApp = statements.filter(
    (statement) => statement.target?.package_name === identities.google.packageName,
  );
  if (forThisApp.length === 0) {
    findings.push({
      file,
      severity: "error",
      message: `no statement names ${identities.google.packageName}`,
    });
  }

  for (const statement of statements) {
    const packageName = statement.target?.package_name;
    if (packageName && packageName !== identities.google.packageName) {
      // Another package listed here can open our links, which is a decision
      // nobody made on purpose.
      findings.push({
        file,
        severity: "error",
        message: `an unexpected package (${packageName}) is granted our links`,
      });
    }
    if (statement.target?.namespace && statement.target.namespace !== "android_app") {
      findings.push({
        file,
        severity: "error",
        message: `unexpected namespace ${statement.target.namespace}`,
      });
    }
    if (!statement.relation?.includes("delegate_permission/common.handle_all_urls")) {
      findings.push({
        file,
        severity: "error",
        message: "missing handle_all_urls, so App Links will not verify",
      });
    }
    for (const fingerprint of statement.target?.sha256_cert_fingerprints ?? []) {
      if (isPlaceholder(fingerprint)) {
        findings.push({
          file,
          severity: "pending",
          message: "the certificate fingerprint is still a placeholder",
        });
        continue;
      }
      if (!SHA256_FINGERPRINT.test(fingerprint)) {
        findings.push({
          file,
          severity: "error",
          message: `${fingerprint} is not a SHA-256 certificate fingerprint`,
        });
        continue;
      }
      if (
        !pending &&
        fingerprint.replace(/:/g, "").toLowerCase() !==
          expectedFingerprint.replace(/:/g, "").toLowerCase()
      ) {
        findings.push({
          file,
          severity: "error",
          message: "the fingerprint does not match the recorded Play app-signing certificate",
        });
      }
    }
  }

  return findings;
}

export function checkAll(
  identities: PublicSigningIdentities,
  files: { apple?: string; assetlinks?: string },
): LinkFinding[] {
  return [
    ...checkIdentities(identities),
    ...(files.apple === undefined ? [] : checkAppleAssociation(files.apple, identities)),
    ...(files.assetlinks === undefined ? [] : checkAssetLinks(files.assetlinks, identities)),
  ];
}
