import type { db } from "../db";
import { resolveSettingValues } from "./settings";

export const EXTENSION_CATALOG_SOURCE_MODES = ["latest", "pinned"] as const;
export type ExtensionCatalogSourceMode = (typeof EXTENSION_CATALOG_SOURCE_MODES)[number];

/** The administrator's choices for the extension store and installed extensions. */
export interface ExtensionPolicy {
  catalogSource: ExtensionCatalogSourceMode;
  revocationCheck: boolean;
  remoteDisable: boolean;
  prereleaseOptIn: string[];
}

/**
 * The extension settings as they resolve now, read together so a caller sees
 * one consistent set. A stored value a setting does not accept throws
 * SettingValueError.
 */
export async function readExtensionPolicy(
  options: { database?: typeof db | null } = {},
): Promise<ExtensionPolicy> {
  const values = await resolveSettingValues(
    [
      "extensions.catalogSource",
      "extensions.revocationCheck",
      "extensions.remoteDisable",
      "extensions.prereleaseOptIn",
    ],
    options,
  );
  return {
    catalogSource: values["extensions.catalogSource"] as ExtensionCatalogSourceMode,
    revocationCheck: values["extensions.revocationCheck"] as boolean,
    remoteDisable: values["extensions.remoteDisable"] as boolean,
    prereleaseOptIn: values["extensions.prereleaseOptIn"] as string[],
  };
}
