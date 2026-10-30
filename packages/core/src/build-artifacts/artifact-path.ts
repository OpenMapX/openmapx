import { createHash } from "node:crypto";
export function safeArtifactPath(path: string, maxBytes = 4096, maxDepth = 64): boolean {
  return (
    !!path &&
    Buffer.byteLength(path) <= maxBytes &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    path.split("/").length <= maxDepth &&
    path.split("/").every((p) => !!p && p !== "." && p !== ".." && Buffer.byteLength(p) <= 255)
  );
}
export function artifactFingerprint(
  files: readonly { path: string; sizeBytes: number; sha256: string }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((f) => [f.path, f.sizeBytes, f.sha256]),
      ),
    )
    .digest("hex");
}
