import { assertTrustedConfigurationSchema } from "./configuration-schema";
import { validateServiceManifest } from "./manifest-schema";
import type { ServiceManifest } from "./types";

const COMMUNITY_SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Why a community service manifest would be rejected, beyond the third-party
 * manifest schema: a plain service id, a community quality label, an image
 * pinned by digest, and a configuration schema the trusted renderer accepts.
 * The operations agent applies these rules before it installs a repository and
 * whenever it reads its community store; the API applies them again to the
 * manifests the agent reports.
 */
export function communityServiceManifestProblems(raw: unknown): string[] {
  const validation = validateServiceManifest(raw, { firstParty: false });
  if (!validation.valid) return validation.errors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["Manifest is not an object"];
  const manifest = raw as ServiceManifest;
  const problems: string[] = [];
  if (!COMMUNITY_SERVICE_ID.test(manifest.id)) {
    problems.push(`Service id "${manifest.id}" may only use lowercase letters, digits and hyphens`);
  }
  // Both labels get the same sandbox; the schema already refuses "built-in" here.
  if (manifest.quality !== "community" && manifest.quality !== "community-verified") {
    problems.push(`Service "${manifest.id}" must declare a community quality`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.container.digest ?? "")) {
    problems.push(`Service "${manifest.id}" must pin its container image by sha256 digest`);
  }
  try {
    assertTrustedConfigurationSchema(manifest.configSchema);
  } catch (error) {
    problems.push(
      `Service "${manifest.id}" has an unsupported configuration schema: ${(error as Error).message}`,
    );
  }
  return problems;
}
