/** Frozen checked release inputs. This schema is data, never an effect issuer. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { configurationReleaseForwardSchema } from "../ops/configuration-release-downloads";
import {
  canonicalReleaseManifest,
  normalizeReleaseSelection,
  parseReleaseManifest,
} from "../services/release-manifest";

export const configurationReleaseSnapshotSchema = configurationReleaseForwardSchema
  .extend({
    imagePrefix: z.string().min(1).max(255),
    canonicalManifest: z.string().min(1).max(32768),
  })
  .superRefine((value, context) => {
    try {
      const selection = normalizeReleaseSelection("main", `${value.imagePrefix}/release-manifest`);
      if (
        selection.kind === "local" ||
        selection.imagePrefix !== value.imagePrefix ||
        Buffer.byteLength(value.canonicalManifest) > 32768
      )
        throw Error();
      const manifest = parseReleaseManifest(value.canonicalManifest, value.imagePrefix),
        canonical = canonicalReleaseManifest(manifest),
        images = {
          "app-api": manifest.images.api,
          "app-web": manifest.images.web,
          "data-manager": manifest.images["data-manager"],
          "ops-agent": manifest.images["ops-agent"],
          "transitous-runner": manifest.images["transitous-runner"],
        };
      if (
        manifest.release !== value.releaseId ||
        canonical !== value.canonicalManifest ||
        createHash("sha256").update(canonical).digest("hex") !== value.manifestDigest ||
        canonicalJson(images) !== canonicalJson(value.serviceImages) ||
        value.downloads.images.some((image) => image.reference !== manifest.images[image.image])
      )
        throw Error();
    } catch {
      context.addIssue({
        code: "custom",
        message: "Checked release snapshot changed or exceeds capacity",
      });
    }
  });
export type ConfigurationReleaseSnapshot = z.infer<typeof configurationReleaseSnapshotSchema>;
