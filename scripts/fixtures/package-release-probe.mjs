import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { planPackageRelease, publishPackageRelease } from "../package-release.mjs";
import { createPackageReleasePorts, readPackageCandidate } from "../package-release-io.mjs";

// Fixed JSON-input executable for the actual native-pack/clean-consumer receipt.
// Only qualification uses real ports. Publishing mutations are in-memory stubs.
const input = JSON.parse(readFileSync(0, "utf8"));
const batch = planPackageRelease(input.plan);
const ports = createPackageReleasePorts({ cwd: input.cwd, directory: input.directory });
const candidate = await ports.qualify(batch, input.plan.nativePlan);
const hashes = candidate.packages.map((item) =>
  createHash("sha512").update(readFileSync(item.path)).digest("hex"),
);
const delivered = [];
await publishPackageRelease(
  { context: batch.context, artifactId: 1, candidateHash: candidate.hash },
  {
    readCandidate: async (request) =>
      readPackageCandidate({
        directory: input.directory,
        expectedHash: request.candidateHash,
        context: request.context,
      }),
    validateArtifact: async () => {},
    assertNpm: async () => {},
    registryVersion: async () => ({ present: true }),
    verifyPublished: async (item) => {
      if (
        createHash("sha512").update(readFileSync(item.path)).digest("hex") !==
        hashes[delivered.length]
      )
        throw new Error("Changed qualification bytes delivered to synthetic publishing");
      delivered.push(item.path);
    },
    readTag: async () => null,
    createTag: async () => {},
  },
);
console.log(
  JSON.stringify({
    hash: candidate.hash,
    exactPathsDelivered: delivered,
    hashes,
    directory: input.directory,
  }),
);
