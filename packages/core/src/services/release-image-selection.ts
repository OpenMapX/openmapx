/** Read-only eligibility shared by CLI preparation and the fixed normal pull.
 * This module never resolves, writes or repairs an overlay. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceImageReferenceSchema } from "@openmapx/extension-contracts/service";
import { JSON_SCHEMA, load } from "js-yaml";
import { canonicalJson } from "../ops/canonical-json";
import {
  parseReleaseComposeSelection,
  RELEASE_IMAGE_NAMES,
  RELEASE_PINNED_SERVICE_IDS,
  type ReleaseChannel,
  type ReleaseComposeSelection,
  releaseChannel,
} from "./release-manifest";
export function configurationImageReference(composeYaml: string, serviceId: string) {
  const document = load(composeYaml, { schema: JSON_SCHEMA }) as {
    services?: Record<string, { image?: unknown }>;
  };
  return serviceImageReferenceSchema.parse(document?.services?.[serviceId]?.image);
}

export function validateExistingReleaseSelection(
  raw: string,
  channel: ReleaseChannel = releaseChannel(),
): ReleaseComposeSelection {
  const selected = parseReleaseComposeSelection(raw),
    prefix =
      channel.kind === "enabled" ? channel.imagePrefix : selected.images.api?.split("/api@")[0];
  if (
    !selected.release ||
    !prefix ||
    !RELEASE_IMAGE_NAMES.every(
      (name) =>
        selected.images[name]?.startsWith(`${prefix}/${name}@`) &&
        serviceImageReferenceSchema.safeParse(selected.images[name]).success,
    )
  )
    throw Error(
      "Existing release overlay is malformed or belongs to another configured repository; explicitly reselect or clear it",
    );
  return selected;
}

export function readServiceReleaseImageSelection(infraDir: string, serviceId: string) {
  const managed = (RELEASE_PINNED_SERVICE_IDS as readonly string[]).includes(serviceId),
    channel = releaseChannel(),
    path = join(infraDir, "docker-compose.release.yml");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024)
      throw Error("Release selection unavailable");
    const raw = readFileSync(fd),
      after = fstatSync(fd),
      current = lstatSync(path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs ||
      current.ctimeMs !== after.ctimeMs
    )
      throw Error("Release selection changed");
    const selected = validateExistingReleaseSelection(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
      channel,
    );
    return {
      imageReference: managed
        ? selected.images[
            serviceId === "app-api"
              ? "api"
              : serviceId === "app-web"
                ? "web"
                : (serviceId as keyof typeof selected.images)
          ]!
        : null,
      releaseSelectionDigest: managed
        ? createHash("sha256")
            .update("openmapx-service-release-selection-v1\0")
            .update(canonicalJson(selected))
            .digest("hex")
        : null,
    };
  } catch (error) {
    if (
      fd !== undefined ||
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      (managed && channel.kind !== "disabled")
    )
      throw error;
    return { imageReference: null, releaseSelectionDigest: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
