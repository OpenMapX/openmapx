// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: manual Actions entrypoint does not run as a cached Turbo task.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, productVersionPattern } from "./product-release-config.mjs";
import {
  candidateHash,
  canonicalCandidate,
  compareProductVersions,
  digestPattern,
  planProductRelease,
  productImageNames,
  sha256,
  validateReadiness,
} from "./product-release-plan.mjs";

const fixedAssets = [
  "candidate.json",
  "release-manifest.json",
  "docker-compose.release.yml",
  "privacy-release-validation.json",
  "INSTALL.md",
  "notes.md",
];
function main(ports) {
  assert(ports.ref === "refs/heads/main", "Named release orchestration must run on main");
}
function overlay(manifest) {
  const images = manifest.images;
  return `# Exact rehearsal selection; use the matching source checkout.\nx-openmapx-release: ${canonicalCandidate({ release: manifest.release, images, product: manifest.product })}\nservices:\n  app-api:\n    image: ${images.api}\n    environment:\n      OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE: ${images["privacy-backup"]}\n      PRIVACY_EXPORT_VALIDATION_EVIDENCE_FILE: /run/openmapx/privacy-release-validation.json\n    configs:\n      - source: privacy-release-validation\n        target: /run/openmapx/privacy-release-validation.json\n  app-web:\n    image: ${images.web}\n  data-manager:\n    image: ${images["data-manager"]}\n    environment:\n      OPENMAPX_TRANSITOUS_TOOLS_IMAGE: ${images["transitous-tools"]}\n  ops-agent:\n    image: ${images["ops-agent"]}\n    environment:\n      OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED: "true"\n      OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE: ${images["privacy-backup"]}\n  transitous-runner:\n    image: ${images["transitous-runner"]}\nconfigs:\n  privacy-release-validation:\n    content: ${JSON.stringify(`${canonicalCandidate(manifest.privacyReleaseValidation)}\n`)}\n`;
}
function assetsFor(candidate, digest, notes) {
  const envelope = {
    candidate,
    candidateHash: candidateHash(candidate),
    candidateManifestDigest: digest,
  };
  const assets = {
    "candidate.json": `${canonicalCandidate(envelope)}\n`,
    "release-manifest.json": `${canonicalCandidate(candidate.manifest)}\n`,
    "docker-compose.release.yml": overlay(candidate.manifest),
    "privacy-release-validation.json": `${canonicalCandidate(candidate.manifest.privacyReleaseValidation)}\n`,
    "notes.md": notes,
    "INSTALL.md": `# Candidate ${candidate.version}\n\nNot published until the owner approves the protected publishing job.\n\nCheck out ${candidate.repository} at exact source ${candidate.sourceRevision}. Use the installation instructions at that source. Set OPENMAPX_RELEASE=${digest} and OPENMAPX_RELEASE_MANIFEST_REPOSITORY=ghcr.io/${candidate.repository.toLowerCase().split("/")[0]}/release-manifest, then run pnpm openmapx compose release before starting services. This resolves the exact staged candidate; no preview fallback is permitted. The accompanying overlay is an auditable seven-image summary; use the CLI-generated selection and privacy evidence paths for normal host operations.\n\nRehearse clean installation and ${candidate.manifest.product.upgradeOrigins.join(", ")} upgrade, selected service health and critical flows. Image rollback does not reverse database migrations. Record actual recovery limits and evidence in readiness.json; no backups are created automatically by these instructions.\n`,
  };
  assets.SHA256SUMS = fixedAssets.map((name) => `${sha256(assets[name])}  ${name}\n`).join("");
  return assets;
}
export async function prepareProductRelease({ sourceRunId }, ports) {
  main(ports);
  assert(Number.isSafeInteger(sourceRunId) && sourceRunId > 0, "Invalid source CI run ID");
  const input = await ports.producer(sourceRunId);
  assert(
    input.run.id === sourceRunId && input.repository === ports.repository,
    "Producer selection changed",
  );
  const candidate = planProductRelease(input);
  await ports.verifyTagTarget(candidate.version, candidate.sourceRevision, "check");
  const existing = await ports.draft(candidate.version);
  if (existing?.assets["candidate.json"]) {
    const prior = JSON.parse(existing.assets["candidate.json"]);
    assert(
      prior && canonicalCandidate(prior.candidate) === canonicalCandidate(candidate),
      "Version already has conflicting candidate content; prepare a new version",
    );
    assert(existing.target === candidate.sourceRevision, "Existing release target mismatch");
    assert(
      digestPattern.test(prior.candidateManifestDigest) &&
        canonicalCandidate(await ports.extractManifest(prior.candidateManifestDigest)) ===
          canonicalCandidate(candidate.manifest),
      "Existing candidate metadata mismatch",
    );
    const expected = assetsFor(candidate, prior.candidateManifestDigest, input.notes);
    for (const [name, bytes] of Object.entries(existing.assets))
      if (name !== "readiness.json")
        assert(expected[name] === bytes, `Conflicting draft asset ${name}`);
    if (existing.draft) await ports.writeDraft({ ...existing, assets: expected });
    return {
      version: candidate.version,
      candidateHash: candidateHash(candidate),
      candidateManifestDigest: prior.candidateManifestDigest,
      draftId: existing.id,
    };
  }
  const digest = await ports.packageManifest(candidate.manifest, candidateHash(candidate));
  assert(digestPattern.test(digest), "Missing frozen candidate metadata digest");
  assert(
    canonicalCandidate(await ports.extractManifest(digest)) ===
      canonicalCandidate(candidate.manifest),
    "Staged metadata differs from candidate",
  );
  const draft = await ports.writeDraft({
    version: candidate.version,
    target: candidate.sourceRevision,
    draft: true,
    prerelease: true,
    assets: assetsFor(candidate, digest, input.notes),
  });
  return {
    version: candidate.version,
    candidateHash: candidateHash(candidate),
    candidateManifestDigest: digest,
    ...(draft.status === "owner-action-required" ? draft : { draftId: draft.id }),
  };
}
async function inspect({ version, expectedCandidateHash }, ports) {
  main(ports);
  await ports.verifyEnvironment();
  assert(
    typeof version === "string" &&
      productVersionPattern.test(version.replace(/^v/, "")) &&
      version.startsWith("v"),
    "Invalid prerelease version",
  );
  assert(/^[a-f0-9]{64}$/.test(expectedCandidateHash ?? ""), "Expected candidate hash is required");
  const draft = await ports.draft(version);
  assert(draft?.prerelease, "Missing named prerelease draft");
  assert(
    Object.keys(draft.assets).every((name) =>
      [...fixedAssets, "SHA256SUMS", "readiness.json"].includes(name),
    ),
    "Unexpected release asset",
  );
  const envelope = JSON.parse(draft.assets["candidate.json"] ?? "null");
  assert(
    envelope?.candidate && digestPattern.test(envelope.candidateManifestDigest),
    "Missing staged candidate",
  );
  const candidate = envelope.candidate;
  const source = await ports.producer(candidate.manifest?.producer?.runId, {
    attempt: candidate.manifest?.producer?.runAttempt,
    digest: candidate.producerManifestDigest,
  });
  assert(
    canonicalCandidate(planProductRelease(source)) === canonicalCandidate(candidate),
    "Candidate no longer matches eligible source evidence",
  );
  assert(
    candidate.repository === ports.repository &&
      candidate.version === version &&
      envelope.candidateHash === expectedCandidateHash &&
      candidateHash(candidate) === expectedCandidateHash,
    "Candidate identity mismatch",
  );
  assert(
    draft.target === candidate.sourceRevision && /^[a-f0-9]{40}$/.test(draft.target),
    "Draft source target mismatch",
  );
  const expected = assetsFor(candidate, envelope.candidateManifestDigest, draft.assets["notes.md"]);
  assert(
    sha256(draft.assets["notes.md"]) === candidate.notesSha256 &&
      draft.body === source.notes &&
      draft.body === draft.assets["notes.md"] &&
      draft.name === version,
    "Release public notes/name mismatch",
  );
  for (const [name, bytes] of Object.entries(expected))
    assert(draft.assets[name] === bytes, `Draft asset mismatch: ${name}`);
  assert(
    canonicalCandidate(await ports.extractManifest(envelope.candidateManifestDigest)) ===
      canonicalCandidate(candidate.manifest),
    "Frozen metadata artifact unavailable or different",
  );
  validateReadiness(
    JSON.parse(draft.assets["readiness.json"] ?? "null"),
    candidate,
    envelope.candidateManifestDigest,
  );
  await ports.verifyTagTarget(version, candidate.sourceRevision, draft.draft ? "check" : "require");
  return {
    draft,
    candidate,
    digest: envelope.candidateManifestDigest,
    approvalHash: publicationHash(draft),
  };
}
function publicationHash(draft) {
  return sha256(
    canonicalCandidate({
      id: draft.id,
      version: draft.version,
      name: draft.name,
      body: draft.body,
      prerelease: draft.prerelease,
      target: draft.target,
      assets: draft.assets,
    }),
  );
}
export async function inspectPublication(inputs, ports) {
  const result = await inspect(inputs, ports);
  return {
    version: result.candidate.version,
    approvalHash: result.approvalHash,
    candidateHash: candidateHash(result.candidate),
    candidateManifestDigest: result.digest,
    sourceRevision: result.candidate.sourceRevision,
    draftUrl:
      result.draft.url ??
      `https://github.com/${ports.repository}/releases/tag/${result.candidate.version}`,
    assets: Object.fromEntries(
      Object.entries(result.draft.assets).map(([name, bytes]) => [name, sha256(bytes)]),
    ),
    readiness: JSON.parse(result.draft.assets["readiness.json"]),
  };
}
export async function publishProductRelease(
  { version, expectedCandidateHash, approvalHash },
  ports,
) {
  const {
    draft,
    candidate,
    digest,
    approvalHash: actual,
  } = await inspect({ version, expectedCandidateHash }, ports);
  assert(
    approvalHash === actual,
    "Draft/readiness changed while owner approval was paused; inspect and approve again",
  );
  // Mandatory current policy applies to all exact images, including reused ones.
  for (const name of productImageNames) await ports.scan(candidate.manifest.images[name]);
  const aliases = productImageNames.map((name) => {
    const [image, imageDigest] = candidate.manifest.images[name].split("@");
    return [`${image}:${version}`, imageDigest];
  });
  aliases.push([
    `ghcr.io/${ports.repository.toLowerCase().split("/")[0]}/release-manifest:${version}`,
    digest,
  ]);
  for (const [reference, imageDigest] of aliases) {
    if (draft.draft) await ports.tag(reference, imageDigest);
    else await ports.requireAlias(reference, imageDigest);
  }
  if (draft.draft) {
    const authority = await ports.mutationAuthority(candidate.sourceRevision);
    if (authority.automated)
      await ports.verifyTagTarget(version, candidate.sourceRevision, "create");
    // Scans/tagging are slow. Bind the complete public payload again at the irreversible boundary.
    const final = await ports.draft(version, draft.id);
    assert(
      final?.draft === true && publicationHash(final) === approvalHash,
      "Draft changed during scanning/promotion; inspect and approve again",
    );
    await ports.verifyTagTarget(version, candidate.sourceRevision, "check");
    if (!authority.automated)
      return ports.ownerHandoff({
        operation: "publish",
        target: candidate.sourceRevision,
        version,
        id: draft.id,
        candidateHash: expectedCandidateHash,
        approvalHash,
        authority,
        snapshot: {
          id: final.id,
          name: final.name,
          body: final.body,
          prerelease: final.prerelease,
          target: final.target,
          assets: final.assets,
        },
        candidateManifestDigest: digest,
      });
    await ports.publish(final, candidate);
  }
  await ports.verifyPublished(version, candidate, draft);
  const current = await ports.preview();
  if (current) {
    assert(
      digestPattern.test(current.digest) && typeof current.version === "string",
      "Invalid preview identity",
    );
    if (compareProductVersions(current.version, version) > 0)
      return { published: true, previewAdvanced: false };
    if (current.version === version) {
      assert(current.digest === digest, "Conflicting existing preview");
      return { published: true, previewAdvanced: false };
    }
  }
  await ports.advancePreview({ version, digest });
  const readback = await ports.preview();
  assert(readback?.version === version && readback.digest === digest, "Preview readback mismatch");
  return { published: true, previewAdvanced: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createReleasePorts } = await import("./product-release-io.mjs");
  const ports = createReleasePorts();
  const operation = process.argv[2];
  const inputs = {
    sourceRunId: Number(process.env.SOURCE_RUN_ID),
    version: process.env.PRODUCT_VERSION,
    expectedCandidateHash: process.env.EXPECTED_CANDIDATE_HASH,
    approvalHash: process.env.EXPECTED_APPROVAL_HASH,
  };
  const result =
    operation === "prepare"
      ? await prepareProductRelease(inputs, ports)
      : operation === "inspect"
        ? await inspectPublication(inputs, ports)
        : operation === "publish"
          ? await publishProductRelease(inputs, ports)
          : (() => {
              throw new Error("Choose prepare, inspect or publish");
            })();
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(result)) {
      if (["string", "number", "boolean"].includes(typeof value))
        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Exact release candidate\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nReview draft assets and readiness evidence before approving named-release.\n`,
    );
}
