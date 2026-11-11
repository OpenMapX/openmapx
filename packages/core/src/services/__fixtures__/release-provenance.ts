import { RELEASE_IMAGE_NAMES, type ReleaseManifest } from "../release-manifest";

/**
 * The producer and build metadata every published release manifest carries,
 * for fixtures that build a manifest by hand. Keys are in canonical order, so
 * a manifest spread from these serializes to its canonical bytes.
 */
export function releaseProvenance(
  sourceRevision = "a".repeat(40),
): Pick<ReleaseManifest, "producer" | "buildMetadata"> {
  const builtAt = "2026-09-05T12:00:00.000Z";
  return {
    producer: {
      event: "push",
      repository: "openmapx/openmapx",
      runAttempt: 1,
      runId: 1,
      sourceRevision,
      workflowPath: ".github/workflows/ci.yml",
    },
    buildMetadata: {
      images: Object.fromEntries(
        [...RELEASE_IMAGE_NAMES]
          .sort((a, b) => a.localeCompare(b))
          .map((name) => [
            name,
            { builtAt, coldRefreshedAt: builtAt, inputHash: "0".repeat(64), sourceRevision },
          ]),
      ),
      version: 1,
    },
  };
}
