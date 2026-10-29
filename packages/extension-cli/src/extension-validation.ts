import {
  extensionManifestSchema,
  validateExtensionManifest,
} from "@openmapx/extension-contracts/extension";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "@openmapx/extension-contracts/platform";

/** Compose portable manifest validity with this tool's supported extension protocol. */
export function validateExtensionAuthoringInput(raw: unknown): {
  valid: boolean;
  errors: string[];
} {
  const result = validateExtensionManifest(raw);
  if (!result.valid) return result;
  const manifest = extensionManifestSchema.parse(raw);
  if (manifest.platform !== undefined && !satisfiesPlatformVersion(manifest.platform)) {
    return {
      valid: false,
      errors: [
        `Extension protocol ${manifest.platform} is not compatible with ${PLATFORM_VERSION}`,
      ],
    };
  }
  return result;
}
