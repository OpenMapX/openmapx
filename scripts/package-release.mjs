// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: manual package workflow entry point.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { assert, planPackageRelease, validateContext } from "./package-release-plan.mjs";

export { planPackageRelease } from "./package-release-plan.mjs";

export async function preparePackageRelease(input, ports) {
  const inspected = await ports.inspectSource(input);
  const batch = planPackageRelease(inspected);
  return ports.qualify(batch, inspected.nativePlan);
}

export async function publishPackageRelease(request, ports) {
  validateContext(request.context);
  assert(
    Number.isSafeInteger(request.artifactId) &&
      request.artifactId > 0 &&
      /^[a-f0-9]{64}$/.test(request.candidateHash),
    "Invalid exact artifact identity",
  );
  const candidate = await ports.readCandidate(request);
  await ports.validateArtifact(candidate, request);
  assert(
    candidate.batch.operation === "publish",
    "Bootstrap qualification cannot authorize publishing",
  );
  await ports.assertNpm();
  const existing = new Map();
  // Validate every candidate, existing registry version and tag before mutation.
  for (const item of candidate.packages) {
    const metadata = await ports.registryVersion(item);
    if (metadata) await ports.verifyPublished(item, metadata, candidate.batch);
    existing.set(item.name, metadata);
    const target = await ports.readTag(item);
    assert(
      target === null || target === candidate.batch.context.sha,
      `Conflicting package tag: ${item.name}@${item.version}`,
    );
  }
  for (const item of candidate.packages) {
    if (!existing.get(item.name)) {
      await ports.publishTarball(item);
      let metadata;
      for (let attempt = 0; attempt < 5; attempt++) {
        metadata = await ports.registryVersion(item);
        if (metadata?.dist?.attestations || metadata?.present) break;
        if (attempt < 4) await ports.wait(3000);
      }
      assert(metadata, `Published version did not propagate: ${item.name}@${item.version}`);
      await ports.verifyPublished(item, metadata, candidate.batch);
    }
  }
  for (const item of candidate.packages) await ports.createTag(item, candidate.batch.context.sha);
  return candidate;
}

export function packageCandidateSummary(candidate) {
  const { batch, receipt } = candidate;
  return [
    `Package ${batch.operation}: ${candidate.hash}`,
    `Source: ${batch.context.sha}`,
    `Workflow: ${batch.context.workflowRef}`,
    `Run: ${batch.context.runId}, attempt: ${batch.context.attempt}`,
    `CI: ${JSON.stringify(batch.sourceCI)}`,
    `Version PR: ${JSON.stringify(batch.versionPr)}`,
    `Tools: ${JSON.stringify(receipt.tools)}`,
    `Native pack plan SHA256: ${receipt.nativePlanSha256}`,
    `Qualification: strict TypeScript and CLI consumer passed`,
    ...candidate.all.map(
      (p) => `${p.selected ? "selected" : "consumer-only"}: ${p.name}@${p.version} ${p.integrity}`,
    ),
    ...(batch.operation === "qualify"
      ? [
          "Qualification only; first publication/account setup requires separate authorization. See docs/docs/developer/package-releases.md.",
        ]
      : []),
    "",
  ].join("\n");
}

async function main() {
  const operation = process.argv[2];
  assert(
    ["qualify", "publish"].includes(operation),
    "Usage: node scripts/package-release.mjs <qualify|publish>",
  );
  const { createPackageReleasePorts } = await import("./package-release-io.mjs");
  const ports = createPackageReleasePorts();
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  validateContext(context);
  const stage = process.env.PACKAGE_RELEASE_STAGE;
  let result;
  if (operation === "publish" && stage === "publish") {
    result = await publishPackageRelease(
      {
        context,
        artifactId: Number(process.env.PACKAGE_ARTIFACT_ID),
        candidateHash: process.env.PACKAGE_CANDIDATE_HASH,
      },
      ports,
    );
  } else {
    assert(stage === "qualify", "Invalid package release stage");
    result = await preparePackageRelease(
      {
        operation,
        context,
        sourceRunId: Number(process.env.SOURCE_RUN_ID),
        versionPr: Number(process.env.VERSION_PR),
      },
      ports,
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `candidate_hash=${result.hash}\n`);
  }
  const summary = packageCandidateSummary(result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`text\n${summary}\`\`\`\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
