import { createHash } from "node:crypto";
import {
  assert,
  exactObject,
  productVersionPattern,
  readProductReleaseConfig,
} from "./product-release-config.mjs";
export const productImageNames = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "privacy-backup",
  "transitous-runner",
  "transitous-tools",
];
export const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function validInstant(value) {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value.slice(0, 10);
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
export const canonicalCandidate = (payload) => JSON.stringify(stable(payload));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const candidateHash = (payload) => sha256(canonicalCandidate(payload));
export function compareProductVersions(a, b) {
  const parse = (value) => {
    const match = productVersionPattern.exec(value.replace(/^v/, ""));
    assert(match, "Invalid product version");
    return [
      ...match.slice(1, 4).map(BigInt),
      BigInt({ alpha: 0, beta: 1, rc: 2 }[match[4]]),
      BigInt(match[5]),
    ];
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < left.length; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function validateProducerManifest(manifest, repository, run) {
  const namespace = `ghcr.io/${repository.toLowerCase().split("/")[0]}`;
  assert(
    manifest?.schemaVersion === 1 &&
      manifest.release === `${run.head_sha}-${run.id}-${run.run_attempt}`,
    "Producer release identity mismatch",
  );
  const expectedProducer = {
    repository,
    workflowPath: ".github/workflows/ci.yml",
    sourceRevision: run.head_sha,
    runId: run.id,
    runAttempt: run.run_attempt,
    event: run.event,
  };
  assert(
    canonicalCandidate(manifest.producer) === canonicalCandidate(expectedProducer),
    "Producer receipt mismatch",
  );
  assert(
    Object.keys(manifest.images ?? {})
      .sort()
      .join() === [...productImageNames].sort().join(),
    "Incomplete seven-image manifest",
  );
  for (const name of productImageNames) {
    const prefix = `${namespace}/${name}@`;
    const image = manifest.images[name];
    assert(
      typeof image === "string" &&
        image.startsWith(prefix) &&
        digestPattern.test(image.slice(prefix.length)),
      `Unapproved ${name} image`,
    );
  }
  const evidence = manifest.privacyReleaseValidation;
  assert(
    evidence?.version === 1 &&
      /^[a-f0-9]{64}$/.test(evidence.sourceBuildFingerprint) &&
      Number.isFinite(Date.parse(evidence.validatedAt)) &&
      ["translationsConsistent", "openApiConsistent", "policyConsistent"].every(
        (key) => evidence.checks?.[key] === true,
      ),
    "Missing privacy evidence",
  );
  assert(manifest.buildMetadata?.version === 1, "Missing build metadata");
  for (const name of productImageNames) {
    const metadata = manifest.buildMetadata.images?.[name];
    assert(
      metadata &&
        /^[a-f0-9]{40}$/.test(metadata.sourceRevision) &&
        /^[a-f0-9]{64}$/.test(metadata.inputHash) &&
        Number.isFinite(Date.parse(metadata.builtAt)),
      `Missing actual build metadata for ${name}`,
    );
  }
}
export function planProductRelease({
  configuration,
  notes,
  run,
  jobs,
  producerManifest,
  producerManifestDigest,
  repository,
}) {
  const config = readProductReleaseConfig(JSON.stringify(configuration));
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "Invalid repository");
  assert(
    run?.repository?.full_name === repository &&
      run.path === ".github/workflows/ci.yml" &&
      run.head_branch === "main" &&
      ["push", "schedule"].includes(run.event) &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      /^[a-f0-9]{40}$/.test(run.head_sha) &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    "Ineligible trusted-main producer run",
  );
  const names = [
    "lint / types / test",
    "Publish coherent release",
    "Validate privacy release evidence",
    ...productImageNames.map((name) => `Build or reuse and scan ${name}`),
  ];
  for (const name of names)
    assert(
      jobs.some(
        (job) =>
          (job.name === name ||
            job.name.endsWith(` / ${name}`) ||
            job.name.endsWith(` / ${name} (${name.replace("Build or reuse and scan ", "")})`)) &&
          job.status === "completed" &&
          job.conclusion === "success",
      ),
      `Required producer job did not succeed: ${name}`,
    );
  assert(digestPattern.test(producerManifestDigest), "Missing immutable producer OCI digest");
  validateProducerManifest(producerManifest, repository, run);
  assert(
    typeof notes === "string" && notes.trim().length >= 24 && notes.length < 1024 * 1024,
    "Missing release notes",
  );
  const product = {
    version: config.version,
    sourceRelease: producerManifest.release,
    sourceRevision: run.head_sha,
    producer: producerManifest.producer,
    notesSha256: sha256(notes),
    compatibility: config.compatibility,
    upgradeOrigins: config.upgradeOrigins,
    limitations: config.limitations,
  };
  const manifest = { ...producerManifest, release: `v${config.version}`, product };
  return {
    schemaVersion: 1,
    repository,
    version: `v${config.version}`,
    sourceRevision: run.head_sha,
    producerManifestDigest,
    configurationSha256: sha256(canonicalCandidate(config)),
    notesSha256: sha256(notes),
    manifest,
  };
}
export const readinessChecks = [
  "cleanInstall",
  "authentication",
  "navigation",
  "savedPlaces",
  "providerFailure",
  "credits",
  "serviceHealth",
  "privacyEvidence",
  "upgrade",
];
export function validateReadiness(readiness, candidate, digest) {
  exactObject(
    readiness,
    [
      "schemaVersion",
      "candidateHash",
      "candidateManifestDigest",
      "environment",
      "platform",
      "testedAt",
      "upgradeOrigin",
      "checks",
      "limitations",
      "immutableReleases",
    ],
    "readiness",
  );
  assert(
    readiness.schemaVersion === 1 &&
      readiness.candidateHash === candidateHash(candidate) &&
      readiness.candidateManifestDigest === digest,
    "Readiness candidate mismatch",
  );
  assert(
    typeof readiness.environment === "string" &&
      readiness.environment.trim().length >= 3 &&
      readiness.platform === "linux/amd64" &&
      validInstant(readiness.testedAt) &&
      candidate.manifest.product.upgradeOrigins.includes(readiness.upgradeOrigin),
    "Incomplete readiness environment/upgrade evidence",
  );
  for (const check of readinessChecks)
    assert(
      readiness.checks?.[check]?.passed === true &&
        typeof readiness.checks[check].evidence === "string" &&
        /^https:\/\//.test(readiness.checks[check].evidence),
      `Missing rehearsal evidence: ${check}`,
    );
  assert(
    Array.isArray(readiness.limitations) &&
      readiness.limitations.every((value) => typeof value === "string"),
    "Missing rehearsal limitations",
  );
  const setting = readiness.immutableReleases;
  assert(
    setting?.enabled === true &&
      setting.repository === candidate.repository &&
      setting.candidateHash === candidateHash(candidate) &&
      typeof setting.checkedBy === "string" &&
      setting.checkedBy.length > 0 &&
      validInstant(setting.checkedAt) &&
      /^https:\/\//.test(setting.evidence ?? ""),
    "Missing bound maintainer immutable-release settings check",
  );
  return readiness;
}
