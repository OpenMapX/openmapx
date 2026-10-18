const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
export function fixture() {
  const names = [
    "api",
    "web",
    "data-manager",
    "ops-agent",
    "privacy-backup",
    "transitous-runner",
    "transitous-tools",
  ];
  const configuration = {
    schemaVersion: 1,
    version: "0.1.0-alpha.1",
    notesPath: "docs/docs/releases/0.1.0-alpha.1.md",
    compatibility: { extensionProtocol: "1.0", platforms: ["linux/amd64"] },
    upgradeOrigins: ["prebaseline"],
    limitations: ["Experimental, no stable support"],
  };
  const producer = {
    repository: "OpenMapX/openmapx",
    workflowPath: ".github/workflows/ci.yml",
    sourceRevision: revision,
    runId: 123,
    runAttempt: 2,
    event: "push",
  };
  const producerManifest = {
    schemaVersion: 1,
    release: `${revision}-123-2`,
    producer,
    images: Object.fromEntries(names.map((name) => [name, `ghcr.io/openmapx/${name}@${digest}`])),
    privacyReleaseValidation: {
      version: 1,
      sourceBuildFingerprint: "c".repeat(64),
      validatedAt: "2026-10-18T10:00:00.000Z",
      checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
    },
    buildMetadata: {
      version: 1,
      images: Object.fromEntries(
        names.map((name) => [
          name,
          {
            sourceRevision: revision,
            inputHash: "d".repeat(64),
            builtAt: "2026-10-18T10:00:00.000Z",
          },
        ]),
      ),
    },
  };
  const jobs = [
    "lint / types / test",
    "Publish coherent release",
    "Validate privacy release evidence",
    ...names.map((name) => `Build or reuse and scan ${name}`),
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  const run = {
    id: 123,
    run_attempt: 2,
    path: ".github/workflows/ci.yml",
    head_sha: revision,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "OpenMapX/openmapx" },
  };
  return {
    configuration,
    notes: "# Intended alpha\n\nExperimental candidate; no release published.\n",
    run,
    jobs,
    producerManifest,
    producerManifestDigest: digest,
    repository: "OpenMapX/openmapx",
  };
}
