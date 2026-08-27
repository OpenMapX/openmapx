#!/usr/bin/env node
/**
 * Fails when the shell could execute code a reviewer never saw.
 *
 * Community integration bundles are arbitrary JavaScript with full access to
 * the page's globals and authenticated origin. Until OpenMapX has a separate
 * presentation isolation boundary, neither the browser nor a signed shell may
 * load them.
 *
 * The guard is structural rather than behavioural. Browser tests exercise the
 * provider, while this release check makes the stronger source-level assertion
 * that the production provider contains no bundle script creation, bundle URL,
 * or community registry initialization path at all.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

interface Finding {
  file: string;
  problem: string;
}

const findings: Finding[] = [];

function read(relativePath: string): string {
  try {
    return readFileSync(resolve(repoRoot, relativePath), "utf8");
  } catch {
    findings.push({ file: relativePath, problem: "file is missing" });
    return "";
  }
}

/**
 * The same source with comments removed.
 *
 * Several checks below look for the *absence* of a word, and these files
 * explain at length why they do not wait for negotiation. Matching prose would
 * fail the build for saying the right thing.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The production provider must contain no executable community loading path. */
const PROVIDER = "apps/web/src/providers/IntegrationProvider.tsx";
const provider = read(PROVIDER);

if (provider) {
  const forbiddenLoaderFragments = [
    'document.createElement("script")',
    "/bundle/index.js",
    "initCommunityIntegrationRegistry",
    "communityBundlesAllowed",
  ];
  for (const fragment of forbiddenLoaderFragments) {
    if (provider.includes(fragment)) {
      findings.push({
        file: PROVIDER,
        problem: `contains disabled bundle loader path: ${fragment}`,
      });
    }
  }
}

/** Deleted loaders and generated runtime artifacts must stay deleted. */
for (const file of [
  "apps/web/src/lib/communityRuntime.ts",
  "apps/web/src/components/map/HostMapProvider.tsx",
  "apps/web/scripts/build-runtime-modules.mjs",
  "apps/web/public/runtime/importmap.json",
  "apps/web/public/runtime/openmapx-core.js",
  "apps/web/public/runtime/openmapx-integration-sdk.js",
  "apps/web/public/runtime/react-dom-client.js",
  "apps/web/public/runtime/react.js",
]) {
  if (existsSync(resolve(repoRoot, file))) {
    findings.push({ file, problem: "obsolete executable community runtime artifact still exists" });
  }
}

/** The boundary itself must not depend on a negotiated state. */
const BOUNDARY = "apps/web/src/lib/mobile/mobileShellEnvironment.ts";
const boundary = read(BOUNDARY);

if (boundary) {
  if (!/microphone:\s*false/.test(boundary)) {
    findings.push({
      file: BOUNDARY,
      problem: "the shell boundary does not disable the microphone",
    });
  }
  // Reading a handshake here would reintroduce the window this exists to close.
  const boundaryCode = withoutComments(boundary);
  for (const forbidden of ["handshake", "selectedProtocolVersion", "negotiat"]) {
    if (boundaryCode.includes(forbidden)) {
      findings.push({
        file: BOUNDARY,
        problem: `consults "${forbidden}", so the boundary would wait for negotiation`,
      });
    }
  }
}

/** No switch anywhere may re-enable what the descriptor turned off. */
const SHELL_BOUNDARY_CONSUMERS = [
  "apps/web/src/components/search/VoiceSearchButton.tsx",
  "apps/web/src/lib/navigation/useNavigationVoice.ts",
  "apps/web/src/lib/navigation/navNotify.ts",
  "apps/web/src/lib/navigation/useNavigationSessionPersistence.ts",
];

for (const file of SHELL_BOUNDARY_CONSUMERS) {
  const source = read(file);
  if (source && !source.includes("shellFeatureBoundary")) {
    findings.push({ file, problem: "no longer consults the shell feature boundary" });
  }
}

/** The signed shell must expose no origin override or script capability. */
const APP = "apps/mobile/src/App.tsx";
const app = read(APP);

if (app) {
  if (!app.includes("limitsNavigationsToAppBoundDomains")) {
    findings.push({ file: APP, problem: "does not limit navigation to app-bound domains" });
  }
  if (!app.includes("originWhitelist={[config.webOrigin]}")) {
    findings.push({ file: APP, problem: "does not allowlist exactly the compiled origin" });
  }
  if (!app.includes('mediaCapturePermissionGrantType="deny"')) {
    findings.push({ file: APP, problem: "does not deny page camera and microphone" });
  }
  if (!app.includes("geolocationEnabled={false}")) {
    findings.push({ file: APP, problem: "does not disable the page's own geolocation" });
  }
  // `injectedJavaScript` (as opposed to the bootstrap-before-content-loaded
  // script, which publishes only a nonce) would be an arbitrary script channel.
  if (/injectedJavaScript=\{/.test(app)) {
    findings.push({ file: APP, problem: "injects arbitrary JavaScript into the page" });
  }
}

if (findings.length > 0) {
  console.error("[assert-no-community-runtime] the store distribution boundary is not intact:\n");
  for (const finding of findings) console.error(`  ${finding.file}: ${finding.problem}`);
  console.error(
    "\nA signed store binary that can execute unreviewed same-origin code is a\n" +
      "remote-code-execution path, not a feature. Fix the boundary rather than\n" +
      "this check.",
  );
  process.exit(1);
}

console.log("[assert-no-community-runtime] the installed shell executes no unreviewed code");
