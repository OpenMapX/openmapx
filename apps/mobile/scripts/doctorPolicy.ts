/**
 * Turns `expo-doctor` output into a pass/fail decision.
 *
 * Every finding fails the gate except one, and only for one reason: this
 * workspace refuses any package published within `minimumReleaseAge`
 * (24 hours) as supply-chain hardening, while expo-doctor asks for the newest
 * SDK patch the moment it exists. For the few hours after each Expo release
 * wave those two rules genuinely cannot both be satisfied, and the repository's
 * policy wins.
 *
 * The tolerance is deliberately narrow and self-limiting:
 *
 *  - it applies only to the "packages match versions required by installed Expo
 *    SDK" finding;
 *  - every package listed must have a newer version that is *younger* than the
 *    minimum release age, checked against the registry rather than assumed;
 *  - once a version becomes installable, the tolerance stops applying and the
 *    gate goes red until someone upgrades.
 *
 * So a genuinely stale dependency still fails, which is the point.
 */

export interface DoctorFinding {
  /** The check heading, without the leading marker. */
  title: string;
  /** Everything expo-doctor printed underneath it. */
  detail: string;
}

export const SDK_VERSION_CHECK =
  "Check that packages match versions required by installed Expo SDK";

export interface OutOfDatePackage {
  name: string;
  expected: string;
  found: string;
}

/** Parses the `✖ <title>` blocks out of an expo-doctor run. */
export function parseDoctorFindings(output: string): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  let current: DoctorFinding | null = null;
  for (const line of output.split("\n")) {
    const failure = line.match(/^\s*[✖✗x]\s+(.*\S)\s*$/);
    if (failure) {
      if (current) findings.push(current);
      current = { title: failure[1], detail: "" };
      continue;
    }
    // A summary line ends the last block; anything after it is not detail.
    if (/^\s*\d+ checks? failed/.test(line)) {
      if (current) findings.push(current);
      current = null;
      continue;
    }
    if (current) current.detail += `${line}\n`;
  }
  if (current) findings.push(current);
  return findings;
}

/**
 * Reads the `package expected found` table expo-doctor prints under the SDK
 * version check.
 */
export function parseOutOfDatePackages(detail: string): OutOfDatePackage[] {
  const packages: OutOfDatePackage[] = [];
  for (const line of detail.split("\n")) {
    const match = line.match(/^\s*(@?[a-z0-9][\w./-]*)\s+([~^]?[\d.]+\S*)\s+([~^]?[\d.]+\S*)\s*$/i);
    if (!match) continue;
    if (match[1] === "package") continue;
    packages.push({ name: match[1], expected: match[2], found: match[3] });
  }
  return packages;
}

/** Publish timestamp of the version expo-doctor wants, per package name. */
export type ExpectedVersionPublishedAt = Map<string, Date | null>;

export interface ReleaseAgeContext {
  publishedAt: ExpectedVersionPublishedAt;
  minimumReleaseAgeMs: number;
  now: Date;
}

/**
 * True when the SDK version finding is entirely explained by the workspace's
 * minimum-release-age policy.
 */
export function isReleaseAgeBlockedUpgrade(
  finding: DoctorFinding,
  context: ReleaseAgeContext,
): boolean {
  if (finding.title !== SDK_VERSION_CHECK) return false;
  const packages = parseOutOfDatePackages(finding.detail);
  if (packages.length === 0) return false;

  return packages.every((pkg) => {
    const published = context.publishedAt.get(pkg.name);
    // An unknown publish date is never tolerated: silence must not pass.
    if (!published) return false;
    return context.now.getTime() - published.getTime() < context.minimumReleaseAgeMs;
  });
}

export interface DoctorDecision {
  ok: boolean;
  blocking: DoctorFinding[];
  tolerated: DoctorFinding[];
}

export function decideDoctorOutcome(output: string, context: ReleaseAgeContext): DoctorDecision {
  const findings = parseDoctorFindings(output);
  const tolerated = findings.filter((finding) => isReleaseAgeBlockedUpgrade(finding, context));
  const blocking = findings.filter((finding) => !isReleaseAgeBlockedUpgrade(finding, context));
  return { ok: blocking.length === 0, blocking, tolerated };
}
