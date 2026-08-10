#!/usr/bin/env node
/**
 * Fails when the generated native projects disagree with the committed build
 * configuration. Run after every `expo prebuild --clean`.
 *
 * Output is limited to identifiers and boolean policy results: no signing
 * material, provisioning data, team identifier, or file content is printed.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedNativeSurface } from "./expectedNativeSurface.ts";
import {
  checkGeneratedNativeSurface,
  summarizeGeneratedNativeSurface,
} from "./generatedNativeChecks.ts";
import {
  expoLocationManifestPaths,
  MissingGeneratedProjectError,
  readGeneratedNativeSurface,
} from "./readGeneratedNative.ts";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<number> {
  const expected = expectedNativeSurface(process.env);
  let generated: Awaited<ReturnType<typeof readGeneratedNativeSurface>>;
  try {
    generated = await readGeneratedNativeSurface(mobileRoot, expoLocationManifestPaths(mobileRoot));
  } catch (error) {
    if (error instanceof MissingGeneratedProjectError) {
      console.error(`assert-generated-native: ${error.message}`);
      return 1;
    }
    throw error;
  }

  for (const [key, value] of Object.entries(summarizeGeneratedNativeSurface(generated, expected))) {
    console.log(`${key}: ${value}`);
  }

  const failures = checkGeneratedNativeSurface(generated, expected);
  if (failures.length > 0) {
    console.error(`\nassert-generated-native: ${failures.length} policy failure(s)`);
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log("\nassert-generated-native: generated native surface matches the committed config");
  return 0;
}

process.exitCode = await main();
