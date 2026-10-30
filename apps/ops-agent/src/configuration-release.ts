/** Checked release data only. Reading this does not acquire targets or grant effects. */
import { createHash } from "node:crypto";
import { AnchoredDirectory } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { z } from "zod";

const selectionSchema = z.strictObject({
  releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
/** Snapshot the existing private checked store, under its existing32KiB limit.
 * Effect producers must revalidate this same identity under their real locks;
 * neither the parsed data nor a matching digest is mutation authority. */
export function readCheckedConfigurationRelease(
  infraDir: string,
  input: { releaseId: string; manifestDigest: string },
) {
  const selected = selectionSchema.parse(input),
    channel = services.releaseSelection();
  if (channel.kind === "local") throw new services.ReleaseChannelDisabledError();
  const infra = new AnchoredDirectory(infraDir);
  try {
    const directory = infra.directory(".ops-agent-releases", false, true);
    try {
      const raw = directory.read(`${selected.releaseId}.json`, 32 * 1024).toString("utf8"),
        manifest = services.parseReleaseManifest(raw, channel.imagePrefix),
        canonical = services.canonicalReleaseManifest(manifest),
        digest = createHash("sha256").update(canonical).digest("hex");
      if (
        manifest.release !== selected.releaseId ||
        canonical !== raw ||
        digest !== selected.manifestDigest
      )
        throw Error("Checked configuration release changed");
      return immutable({
        releaseId: selected.releaseId,
        manifestDigest: digest,
        manifest,
        serviceImages: {
          "app-api": manifest.images.api,
          "app-web": manifest.images.web,
          "data-manager": manifest.images["data-manager"],
          "ops-agent": manifest.images["ops-agent"],
          "transitous-runner": manifest.images["transitous-runner"],
        },
      });
    } finally {
      directory.close();
    }
  } finally {
    infra.close();
  }
}
export type CheckedConfigurationRelease = ReturnType<typeof readCheckedConfigurationRelease>;
