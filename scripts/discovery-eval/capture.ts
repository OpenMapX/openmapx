/** Provenance for filtered API recordings; never represents raw upstream data. */
export function captureMetadata(
  api: string,
  revision: string | null,
  now = new Date(),
  workingTreeDirty = false,
) {
  let base: URL;
  try {
    base = new URL(api);
  } catch {
    throw new Error(
      "Capture API base must be a public HTTP(S) URL without credentials or parameters",
    );
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    // Do not include the input: rejected URLs can contain secrets.
    throw new Error(
      "Capture API base must be a public HTTP(S) URL without credentials or parameters",
    );
  }
  return {
    protocolVersion: 1 as const,
    layer: "adapted-api" as const,
    representation: "selected-fields" as const,
    recordedAt: now.toISOString(),
    captureCodeRevision: revision,
    captureWorkingTreeDirty: workingTreeDirty,
    apiOrigin: base.origin,
    deploymentRevision: null,
    sourceRevisions: null,
    upstreamPayloadCaptured: false,
  };
}
