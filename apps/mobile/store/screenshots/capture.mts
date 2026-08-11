#!/usr/bin/env node
/**
 * Prints the capture plan and the exact commands for each scenario.
 *
 * Deliberately not automated end to end. Driving the real UI through five flows
 * in two languages, on two platforms, with a map that must have finished
 * rendering, is a job where a human looking at each frame catches things no
 * assertion would — a half-loaded tile, a debug overlay, a stale route line.
 *
 * What it does automate is the part worth automating: the exact device, locale,
 * output path and simctl/adb invocation, so captures are consistent and land
 * where `validate.mts` looks for them.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const plan = JSON.parse(readFileSync(resolve(here, "scenarios.json"), "utf8")) as {
  scenarios: {
    id: string;
    caption: Record<string, string>;
    shows: string;
    route: string;
    platforms?: string[];
    primary?: boolean;
  }[];
};

const LOCALES = ["en", "de"] as const;

console.log("# Screenshot capture plan\n");
console.log("Prepare: a local Release build installed, a signed-out app, and the");
console.log("map fully rendered before each capture. Never a real address or account.\n");

for (const scenario of plan.scenarios) {
  const platforms = scenario.platforms ?? ["apple", "google"];
  console.log(
    `## ${scenario.id}${scenario.primary === false ? " (supporting evidence, not a headline)" : ""}`,
  );
  console.log(`\n${scenario.shows}`);
  console.log(`Route: ${scenario.route}\n`);
  for (const locale of LOCALES) {
    console.log(`- ${locale}: "${scenario.caption[locale]}"`);
  }
  console.log("");
  for (const platform of platforms) {
    for (const locale of LOCALES) {
      const output = `apps/mobile/store/assets/${platform}/${locale}/${scenario.id}.png`;
      if (platform === "apple") {
        console.log(`  xcrun simctl io booted screenshot --type=png ${output}`);
      } else {
        console.log(`  adb exec-out screencap -p > ${output}`);
      }
    }
  }
  console.log("");
}

console.log("Then: pnpm -C apps/mobile exec tsx store/screenshots/validate.mts");
