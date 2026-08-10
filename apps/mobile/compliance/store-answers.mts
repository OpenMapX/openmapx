#!/usr/bin/env node
/**
 * Turns the data-practice registry into console worksheets.
 *
 * These are evidence for a human filling in App Store Connect and the Play
 * Console — not an automated legal conclusion. What the generator actually
 * guarantees is narrower and more useful: that the answers a person types match
 * the registry, and that the registry covers everything the app demonstrably
 * does. A worksheet is refused outright if a native permission, a public
 * endpoint, or a local store has no reviewed practice row, because the failure
 * mode this prevents is somebody answering a console question from memory.
 *
 * Run with `--check` in CI to verify the committed worksheets are current.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;

interface Practice {
  id: string;
  dataType: string;
  leavesDevice: boolean;
  recipient?: string;
  endpoint?: string;
  purpose: string;
  linkedToAccount: boolean;
  retention: { kind: string; maxHours?: number; note?: string };
  shared: string;
  userControl: string;
  appleLabel: {
    collected: boolean;
    category: string;
    purposes?: string[];
    linkedToIdentity?: boolean;
    usedForTracking?: boolean;
    exemptionReason?: string;
  };
  googleDataSafety: {
    collected: boolean;
    shared: boolean;
    category?: string;
    ephemeral?: boolean;
    optional?: boolean;
    purposes?: string[];
  };
  legalSection: string;
  notes?: string;
}

const registry = JSON.parse(readFileSync(resolve(here, "data-practices.json"), "utf8")) as {
  version: number;
  practices: Practice[];
};

/**
 * Behaviours the app has that a worksheet must account for.
 *
 * Kept here rather than derived from a scan because a scan would silently pass
 * when a capability is added and the scanner is not taught about it — the point
 * is to fail loudly in exactly that case.
 */
const REQUIRED_COVERAGE: { subject: string; practiceId: string }[] = [
  {
    subject: "iOS NSLocationWhenInUseUsageDescription",
    practiceId: "precise-location-active-navigation",
  },
  {
    subject: "iOS NSLocationAlwaysAndWhenInUseUsageDescription",
    practiceId: "background-location-active-navigation",
  },
  {
    subject: "iOS UIBackgroundModes: location",
    practiceId: "background-location-active-navigation",
  },
  { subject: "Android ACCESS_FINE_LOCATION", practiceId: "precise-location-active-navigation" },
  {
    subject: "Android ACCESS_BACKGROUND_LOCATION",
    practiceId: "background-location-active-navigation",
  },
  {
    subject: "Android FOREGROUND_SERVICE_LOCATION",
    practiceId: "background-location-active-navigation",
  },
  { subject: "Android POST_NOTIFICATIONS", practiceId: "local-alerts" },
  { subject: "POST /api/directions", practiceId: "route-request-coordinates" },
  { subject: "POST /api/transit/plan", practiceId: "transit-plan-and-refresh" },
  { subject: "POST /api/mobile-auth/exchange", practiceId: "system-auth-handoff" },
  { subject: "/api/auth/*", practiceId: "account-and-contact" },
  { subject: "/api/saved/*", practiceId: "saved-places-and-settings" },
  { subject: "local SQLite navigation session", practiceId: "precise-location-active-navigation" },
  { subject: "local diagnostics buffer", practiceId: "diagnostics-export" },
  { subject: "WebView cookies and cache", practiceId: "webview-storage" },
  { subject: "map tile and imagery providers", practiceId: "map-and-media-providers" },
  { subject: "store distribution", practiceId: "store-operational-data" },
];

const byId = new Map(registry.practices.map((practice) => [practice.id, practice]));

const missing = REQUIRED_COVERAGE.filter((entry) => !byId.has(entry.practiceId));
if (missing.length > 0) {
  console.error("[store-answers] refusing to generate: uncovered behaviour\n");
  for (const entry of missing) {
    console.error(`  ${entry.subject} has no practice row (${entry.practiceId})`);
  }
  console.error("\nAnswering a console question that the registry does not cover means");
  console.error("answering it from memory, which is how store answers become wrong.");
  process.exit(1);
}

const generated = registry.practices;
const collectedForApple = generated.filter((practice) => practice.appleLabel.collected);
const collectedForGoogle = generated.filter((practice) => practice.googleDataSafety.collected);

const PREAMBLE = `<!-- Generated from data-practices.json by store-answers.mts. Do not edit by hand:
     change the registry and regenerate, so the policy, the labels and the code
     keep saying the same thing. -->`;

function appleWorksheet(): string {
  const rows = collectedForApple
    .map(
      (practice) =>
        `| ${practice.appleLabel.category} | ${practice.dataType} | ${(practice.appleLabel.purposes ?? []).join(", ")} | ${
          practice.appleLabel.linkedToIdentity ? "Yes" : "No"
        } | No |`,
    )
    .join("\n");

  const exempt = generated
    .filter((practice) => !practice.appleLabel.collected && practice.leavesDevice)
    .map(
      (practice) =>
        `- **${practice.dataType}** — ${practice.appleLabel.exemptionReason ?? practice.notes}`,
    )
    .join("\n");

  return `${PREAMBLE}

# Apple App Privacy worksheet

Transcribe these into App Store Connect → App Privacy. The account holder is
responsible for confirming each answer against the current official questions on
the day of submission; this file records what the app actually does.

## Does this app collect data?

**Yes.** Not because most navigation data leaves the device — it does not — but
because route requests, account details and saved places do. Answering "no" on
the strength of on-device processing alone would be false.

## Data types collected

| Category | What | Purposes | Linked to identity | Used for tracking |
| --- | --- | --- | --- | --- |
${rows}

## Tracking

**No.** The app contains no analytics SDK, no advertising identifier, no crash
reporter, and no cross-app or cross-site measurement of any kind. \`NSPrivacyTracking\`
is \`false\` and there are no tracking domains.

## Data that leaves the device but is not declared as collected

Each of these relies on Apple's documented real-time-processing exception. The
reason is stated so the claim can be checked rather than taken on trust.

${exempt}

## Location, specifically

The app requests **Always** location only to continue guidance on a trip the
user explicitly started, while the screen is locked or the app is backgrounded.
It is never used to build a location history, is never transmitted continuously,
and stops when the trip ends. Coordinates leave the device only to compute a
route the user asked for, or to compute a new one after they have left the
previous route.
`;
}

function googleWorksheet(): string {
  const rows = collectedForGoogle
    .map(
      (practice) =>
        `| ${practice.googleDataSafety.category} | ${practice.dataType} | ${
          practice.googleDataSafety.shared ? "Shared" : "Collected only"
        } | ${practice.googleDataSafety.ephemeral ? "Processed ephemerally" : "Retained"} | ${
          practice.googleDataSafety.optional ? "Optional" : "Required"
        } | ${(practice.googleDataSafety.purposes ?? []).join(", ")} |`,
    )
    .join("\n");

  return `${PREAMBLE}

# Google Play Data safety worksheet

Transcribe into Play Console → App content → Data safety. As with Apple, the
account holder confirms each answer against the current official form.

## Collected and shared

| Category | What | Sharing | Handling | Required | Purposes |
| --- | --- | --- | --- | --- | --- |
${rows}

## Security practices

- All transmission is over HTTPS.
- Users can request deletion in the app and at a public URL that works after
  uninstall: \`https://openmapx.com/delete-account\`.
- The app has been reviewed against these answers rather than the answers being
  written from the app's description.

## Data not collected

Location used for navigation is processed on the device and is not collected.
The stop lists captured before a transit journey, the local alert schedule, the
diagnostics buffer, and the WebView's own storage all stay on the device.

## Location permission declaration

Background location is used **only during an active navigation session the user
started**, to continue turn-by-turn or transit guidance while the screen is
locked. It is not used for advertising, analytics, or any form of tracking, and
the app works without it in foreground-only mode.
`;
}

function backgroundDeclaration(): string {
  const practice = byId.get("background-location-active-navigation") as Practice;
  return `${PREAMBLE}

# Background location declaration

The same words must appear in the OS purpose string, the in-app disclosure, the
privacy policy, the store description, the console declaration, and the review
notes. A reviewer comparing any two of them should find them saying the same
thing — which is the reason this file is generated rather than written six times.

## What the app does

${practice.purpose}

## When it is active

Only while a navigation session the user explicitly started is running. Starting
navigation is a deliberate action: the user plans a route and taps Start. Ending
navigation, or arriving, stops it.

## What the user is told, before the OS prompt

That the app needs location **in the background**, or **when the app is not in
use**, so it can keep guiding them on a route they started while the screen is
locked or the app is minimised; that the guidance is computed on the device;
that coordinates leave the device only to compute a route or a reroute; and that
they can choose foreground-only or end navigation at any time.

## Retention

${practice.retention.note}

## What it is never used for

Advertising, analytics, profiling, location history, or any transmission that is
not a route the user asked for. The app ships no analytics SDK and no crash
reporter.

## Demonstrating it for review

Record a short video that shows: planning a route, the disclosure screen, the OS
prompt, guidance running, the screen locking, guidance continuing audibly, and
the trip being ended. Use a synthetic or public route — never a real home or
work address.
`;
}

const outputs: { file: string; contents: string }[] = [
  { file: "apple-privacy-worksheet.md", contents: appleWorksheet() },
  { file: "google-data-safety-worksheet.md", contents: googleWorksheet() },
  { file: "background-location-declaration.md", contents: backgroundDeclaration() },
];

const checkOnly = process.argv.includes("--check");
let stale = false;

for (const output of outputs) {
  const path = resolve(here, output.file);
  if (checkOnly) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = "";
    }
    if (existing !== output.contents) {
      console.error(`[store-answers] ${output.file} is out of date`);
      stale = true;
    }
    continue;
  }
  writeFileSync(path, output.contents);
  console.log(`[store-answers] wrote ${output.file}`);
}

if (stale) {
  console.error("\nRun `pnpm -C apps/mobile exec tsx compliance/store-answers.mts` and commit.");
  process.exit(1);
}

if (checkOnly) console.log("[store-answers] worksheets match the registry");
