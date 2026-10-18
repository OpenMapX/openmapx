import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseContributors } from "@openmapx/extension-contracts/contributors";
import { validateServiceManifest } from "@openmapx/extension-contracts/service";
import {
  packageIntegration,
  validateIntegrationDirectory,
} from "@openmapx/integration-framework/installer";

import { validateExtensionAuthoringInput } from "../extension-validation.js";

export type AuthoringKind = "integration" | "service" | "extension" | "contributors";
export interface AuthoringValidationResult {
  valid: boolean;
  errors: string[];
}
export async function validateAuthoringInput(
  source: string,
  kind: AuthoringKind = "integration",
): Promise<AuthoringValidationResult> {
  try {
    if (kind === "integration") {
      const result = validateIntegrationDirectory(source);
      if (!result.valid) return result;
      // Apply the packager's exact community policy and asset checks without creating an archive.
      await packageIntegration({
        rootDir: process.cwd(),
        source: resolve(source),
        outFile: "",
        dryRun: true,
      });
      return { valid: true, errors: [] };
    }
    const raw: unknown = JSON.parse(readFileSync(source, "utf8"));
    if (kind === "service") return validateServiceManifest(raw, { firstParty: false });
    if (kind === "extension") return validateExtensionAuthoringInput(raw);
    if (kind === "contributors")
      return parseContributors(raw) !== undefined
        ? { valid: true, errors: [] }
        : {
            valid: false,
            errors: [
              "Expected an array of canonical contributor receipts; use [] only for explicitly empty provenance.",
            ],
          };
    return { valid: false, errors: [`Unsupported validation kind: ${kind}`] };
  } catch (error) {
    return { valid: false, errors: [(error as Error).message] };
  }
}
export async function runValidate(
  source: string,
  kind: AuthoringKind = "integration",
): Promise<void> {
  const result = await validateAuthoringInput(source, kind);
  if (result.valid)
    console.log(
      `✓ ${source}: valid ${kind} authoring input (host installation applies additional runtime checks)`,
    );
  else {
    console.error(`✗ ${source}: invalid ${kind}`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  }
}
