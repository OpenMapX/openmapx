#!/usr/bin/env node
/**
 * Runs the local Maestro smoke flows against an installed build.
 *
 * Maestro is a local binary driving a local simulator or emulator — no hosted
 * device farm, no account, no upload. The wrapper exists so the flows document
 * their own prerequisites: an installed app and a chosen application id, which
 * differ between a development build and a release-configured one.
 *
 * It exits 0 with an explanation when Maestro is not installed, because the
 * flows qualify a device that may not be attached; a missing local tool is not
 * a failure of the code under test. Any flow that actually runs and fails does
 * fail the command.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flowsDir = join(mobileRoot, ".maestro");

const DEFAULT_APP_ID = "org.openmapx.app.dev";

function maestroAvailable(): boolean {
  try {
    execFileSync("maestro", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main(): number {
  if (!existsSync(flowsDir)) {
    console.error(`[mobile:smoke] no flows at ${flowsDir}`);
    return 1;
  }

  const flows = readdirSync(flowsDir)
    .filter((entry) => entry.endsWith(".yaml"))
    .sort();
  console.log(`[mobile:smoke] ${flows.length} flow(s): ${flows.join(", ")}`);

  if (!maestroAvailable()) {
    console.log(
      "[mobile:smoke] maestro is not installed; install it from https://maestro.dev and run again",
    );
    console.log("[mobile:smoke] skipped — flows require an attached simulator or emulator");
    return 0;
  }

  const appId = process.env.MAESTRO_APP_ID ?? DEFAULT_APP_ID;
  console.log(`[mobile:smoke] application id: ${appId}`);

  for (const flow of flows) {
    console.log(`\n[mobile:smoke] ${flow}`);
    try {
      execFileSync("maestro", ["test", join(flowsDir, flow)], {
        cwd: mobileRoot,
        stdio: "inherit",
        env: { ...process.env, MAESTRO_APP_ID: appId },
      });
    } catch {
      console.error(`[mobile:smoke] ${flow} failed`);
      return 1;
    }
  }

  console.log("\n[mobile:smoke] every flow passed");
  return 0;
}

process.exitCode = main();
