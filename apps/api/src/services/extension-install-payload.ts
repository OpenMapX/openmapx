import { assertAllowedGitUrl, services as coreServices } from "@openmapx/core/server";

export interface ExtensionInstallPayload extends Record<string, unknown> {
  manifest: coreServices.ExtensionManifest;
  sourceUrl?: string;
  sourceTrust: "built-in" | "verified" | "community";
  actorId?: string;
  hostPortConfirmation?: string;
}

export class InvalidExtensionInstallPayloadError extends Error {
  override readonly name = "InvalidExtensionInstallPayloadError";

  constructor() {
    super("Invalid extension install payload");
  }
}

export function normalizeExtensionInstallPayload(
  payload: Record<string, unknown>,
): ExtensionInstallPayload {
  const parsed = coreServices.extensionManifestSchema.safeParse(payload.manifest);
  if (!parsed.success) throw new InvalidExtensionInstallPayloadError();

  try {
    const manifest: coreServices.ExtensionManifest = {
      ...parsed.data,
      services: parsed.data.services?.map((service) => ({
        ...service,
        repo: assertAllowedGitUrl(service.repo).canonical,
      })),
      integrations: parsed.data.integrations?.map((integration) => ({
        ...integration,
        artifact: coreServices.canonicalExtensionLocator(integration.artifact),
      })),
    };
    const sourceUrl =
      typeof payload.sourceUrl === "string"
        ? coreServices.canonicalExtensionLocator(payload.sourceUrl)
        : undefined;
    const sourceTrust =
      payload.sourceTrust === "built-in" || payload.sourceTrust === "verified"
        ? payload.sourceTrust
        : "community";
    return {
      manifest,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      sourceTrust,
      ...(typeof payload.actorId === "string" ? { actorId: payload.actorId } : {}),
      ...(typeof payload.hostPortConfirmation === "string" &&
      /^[a-f0-9]{64}$/i.test(payload.hostPortConfirmation)
        ? { hostPortConfirmation: payload.hostPortConfirmation }
        : {}),
    };
  } catch {
    throw new InvalidExtensionInstallPayloadError();
  }
}
