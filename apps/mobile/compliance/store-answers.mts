#!/usr/bin/env node
/**
 * Turns the data-practice registry into console worksheets.
 *
 * These are draft inputs for binary, runtime and privacy qualification before
 * a human completes App Store Connect or Play Console. Generation checks that
 * the manually listed practice IDs exist. It does not discover every behavior,
 * validate classifications, establish review approval or inspect console input.
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
 * Manually maintained coverage subjects and their expected practice IDs.
 *
 * A missing listed ID fails generation. New permissions, endpoints, stores or
 * behaviors remain undetected until a reviewer updates this list. A matching
 * row does not prove that its description is accurate or that it was reviewed.
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
  { subject: "GET /api/integrations/routing/directions", practiceId: "route-request-coordinates" },
  { subject: "GET /api/integrations/transit/plan", practiceId: "transit-plan-and-refresh" },
  { subject: "POST /api/mobile-auth/exchange", practiceId: "system-auth-handoff" },
  { subject: "/api/auth/*", practiceId: "account-and-contact" },
  { subject: "/api/integrations/reviews-mangrove/signer/*", practiceId: "review-shared-signer" },
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
     update registry prose or this template and regenerate. --check verifies
     generated-file parity, not behavior, privacy classifications or approval. -->`;

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
        `- ${practice.dataType}: ${practice.appleLabel.exemptionReason ?? practice.notes}`,
    )
    .join("\n");

  return `${PREAMBLE}

# Apple App Privacy worksheet

DRAFT: qualification input. Do not transcribe these proposals into App Store
Connect until the exact candidate binary, served web/API builds, deployment and
configured providers have completed runtime and privacy review. Confirm the
answers against the current console questions on the day of submission. This
worksheet records no completed store review or proof of compliance.

\`apps/mobile/src/App.tsx\` creates the shell bridge without native navigation
or system-auth dispatch. Ground/transit guidance, background location, local
notifications and speech are reported unavailable. Component behavior below
describes intended native practices, not working installed-shell features.
See [Mobile architecture](../../../docs/docs/developer/mobile-architecture.md).

## Does this app collect data?

Proposed answer: Yes. The registry includes transmitted route inputs, account
details and saved content. All category, purpose, identity and tracking values
below remain pending review; omitted rows do not establish an exemption.

## Data types collected

| Category | What | Purposes | Linked to identity | Used for tracking |
| --- | --- | --- | --- | --- |
${rows}

## Tracking

Proposed answer: No. Verify the exact binary's dependencies and privacy manifests,
the served web code and provider behavior against Apple's tracking definition.
A declared \`NSPrivacyTracking: false\` does not establish runtime behavior.

## Transmitted data currently marked not collected (unresolved)

Under [Apple's collection definition](https://developer.apple.com/app-store/app-privacy-details/),
off-device access beyond the time needed to service the request in real time
counts as collection. Short expiry, hashing and an opaque code do not establish
that condition. Review server rows, logs, backups and partner retention.

The following retained registry values are unresolved proposals. No real-time
exemption has been approved here, including for distributor operational data.

${exempt}

## Location, specifically

Native permission and navigation components are intended to request background
location for a user-started trip, process progress locally and stop on termination.
The current installed shell does not compose that flow or a foreground-only
navigation alternative. Qualify both permission modes on the candidate device.
Route/transit requests transmit inputs; map and imagery requests reveal viewed
areas. Review other enabled web features before describing all location uses.

## Review required before submission

- The auth handoff sends the verifier through \`auth.result\` to the WebView and
  then to API \`/mobile-auth/exchange\`. Server rows contain an account ID;
  redemption expiry and eventual row deletion are different events.
- Saved places are readable by the server/operator and can be shared by bearer
  link. Local review keys are encrypted before upload. Shared signing sends a
  session token and review content through the API to Mangrove, which holds the
  signing key. Provider login also exposes browser request and login data. Public
  submissions use an authenticated relay, so identity linkage needs review.
- Sign-out does not clear every cache or downloaded offline area. Review local
  storage, cookie transmission and deletion controls separately.
- Provider retention is unverified. The proposed ephemeral values also need
  review for transit tokens serialized into native SQLite and diagnostics whose
  storage is limited by size without a demonstrated 24-hour purge.

Use the [user-data trust model](../../../docs/docs/developer/user-data-trust-model.md)
to review readers and storage. Complete candidate runtime/privacy qualification
and current App Store Connect review before approving any console answers.
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

DRAFT: qualification input. Do not transcribe these proposals into Play Console
until the exact candidate binary, served web/API builds, deployment and configured
providers have completed runtime and privacy review. Confirm each answer against
the current console form on the day of submission. This worksheet records no
completed store review or proof of compliance.

\`apps/mobile/src/App.tsx\` does not compose native navigation or system-auth
dispatch. Installed ground/transit guidance, background location, local alerts
and speech are unavailable. Native component descriptions are intended practices
requiring composition and device qualification.
See [Mobile architecture](../../../docs/docs/developer/mobile-architecture.md).

## Collected and shared

Every category, sharing, handling, required/optional and purpose value below is
a proposal pending review. Rows filtered out by the current registry values must
also be reviewed; their absence does not establish that data is not collected.

| Category | What | Sharing | Handling | Required | Purposes |
| --- | --- | --- | --- | --- | --- |
${rows}

## Security practices to verify

- Verify HTTPS for the binary, served web code and every configured provider path.
- Test account-deletion intake in the app and at
  \`https://openmapx.com/delete-account\`, including access after uninstall.
  Review retained records, backups and processor handling separately.
- Complete binary, runtime and privacy review before approving the form answers.

## Transmission and ephemeral processing (unresolved)

[Google's Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
defines collection as off-device transmission, including through an app-controlled
WebView. Transmitted data processed only in memory for the request still belongs
in the form response; qualifying ephemeral handling affects public display.
Apple's real-time retention definition does not decide Google's form answers.

The auth handoff remains marked not collected in the registry pending review,
although the WebView sends code, state and verifier to API \`/mobile-auth/exchange\`
and the server stores an account-linked handoff row. Its two-minute redemption
window does not establish memory-only handling or an approved exemption.

Local navigation processing, captured stops, alert schedules and diagnostics
components have separate transmission boundaries. Diagnostic export can share a
file deliberately; cookies accompany authenticated requests. Local storage alone
does not establish that the underlying data stays on the device.

## Retention, sharing and identity review

- Provider retention and proposed ephemeral tile/media handling are unverified.
  Check each selected provider and deployment's intermediaries, caches and logs.
- Native transit payloads serialize refresh tokens to SQLite. Diagnostics have
  row/byte limits without a demonstrated 24-hour purge. These facts need review
  against the retained retention classifications and budgets.
- Saved content is readable by the server/operator and can be shared through
  bearer links. Local review keys are encrypted before upload. Shared signing sends
  a session token and review through the API to Mangrove, which holds the signing
  key. Provider login also exposes browser request and login data. Public review
  submissions use an authenticated relay; assess identity linkage separately.
- Sign-out leaves offline downloads and some other browser storage. Verify the
  separate removal controls. Review distributor diagnostics and developer-console
  access before accepting the registry's not-collected proposal for store data.

Use the [user-data trust model](../../../docs/docs/developer/user-data-trust-model.md)
and current Play Console questions to resolve these proposals before submission.

## Location permission declaration

The native components are intended to use background location only during an
active navigation session the user started. Qualify disclosure, permission denial,
foreground-only behavior, locked-screen guidance and stop/revocation handling in
the composed candidate. The current installed shell cannot demonstrate this flow.
`;
}

function backgroundDeclaration(): string {
  const practice = byId.get("background-location-active-navigation") as Practice;
  return `${PREAMBLE}

# Background location declaration

DRAFT: qualification input for a future composed candidate. This is not a
submission-ready declaration, evidence of a store review or proof of compliance.
Review the exact binary, served web/API builds, runtime data flows and privacy
practices, then confirm the current console requirements before submission.

\`apps/mobile/src/App.tsx\` does not compose the native navigation/permission/effect
ports or system-auth dispatch. The shell reports background navigation, local
notifications and speech unavailable. Existing components and tests do not
establish installed locked-screen or foreground-only guidance.

Check consistent, accurate descriptions in the OS purpose strings, in-app
disclosure, privacy policy, store description, console declaration and reviewer
notes. This generator does not update or verify those other surfaces.

## Intended native behavior

${practice.purpose}

## When it is active

The intended boundary is a navigation session the user explicitly starts.
Verify that starting the session is deliberate, foreground-only mode pauses as
disclosed, and ending, arriving or revoking permission stops background work.
These are qualification requirements for the composed candidate.

## What the user is told, before the OS prompt

Verify that the disclosure explains background location for the user-started
trip, local progress processing, transmitted route/transit requests and the
foreground-only and stop controls. Map/imagery and other enabled web features
have additional data flows; do not claim all coordinates stay on the device.

## Retention

${practice.retention.note}

All registry retention, collection, sharing and identity values remain proposals
pending privacy review. Session expiry is not proof of immediate disk deletion.
Review provider retention, deployment logs/backups, transit tokens serialized to
SQLite, and diagnostics without a demonstrated age purge.

## Purpose restrictions to verify

The intended background practice supports active guidance. Verify that the exact
candidate and its providers do not use those fixes for advertising, analytics,
profiling or location history. Inspect binary dependencies and served web code;
the registry cannot establish the absence of tracking or crash reporting.

Apply [Apple's collection and real-time retention definition](https://developer.apple.com/app-store/app-privacy-details/)
and [Google's transmission and ephemeral-processing guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
separately. Google's form includes transmitted data processed ephemerally.
An opaque auth code or short expiry does not approve an exemption; its verifier
reaches the API and its server row is account-linked.

## Demonstrating it for review

After composition and candidate device qualification, record the actual flow:
planning a route, disclosure, OS permission handling, guidance, screen locking,
audible guidance and ending the trip. Cover denial and foreground-only behavior
separately. Use a synthetic or public route, and bind observations to the tested
binary and served web/API builds. Do not present component tests or a script as
device evidence. The current installed shell cannot supply this demonstration.
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
