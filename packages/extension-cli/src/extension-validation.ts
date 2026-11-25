import {
  extensionManifestSchema,
  validateExtensionManifest,
} from "@openmapx/extension-contracts/extension";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/extension-contracts/platform";
import {
  communityServiceManifestSchema,
  validateServiceManifest,
} from "@openmapx/extension-contracts/service";

interface AuthoringResult {
  valid: boolean;
  errors: string[];
}

function protocolResult(platform: string, result: AuthoringResult): AuthoringResult {
  if (satisfiesPlatformVersion(platform)) return result;
  return {
    valid: false,
    errors: [`Extension protocol ${platform} is not compatible with ${PLATFORM_VERSION}`],
  };
}

/** Compose portable manifest validity with this tool's supported extension protocol. */
export function validateExtensionAuthoringInput(raw: unknown): AuthoringResult {
  const result = validateExtensionManifest(raw);
  if (!result.valid) return result;
  return protocolResult(extensionManifestSchema.parse(raw).platform, result);
}

/** A community service manifest, checked against this tool's supported extension protocol. */
export function validateServiceAuthoringInput(raw: unknown): AuthoringResult {
  const result = validateServiceManifest(raw, { firstParty: false });
  if (!result.valid) return result;
  return protocolResult(communityServiceManifestSchema.parse(raw).platform, result);
}
