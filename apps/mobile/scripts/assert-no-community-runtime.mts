#!/usr/bin/env node
/**
 * Fails when the shell could execute code a reviewer never saw.
 *
 * Community integration bundles are same-origin arbitrary JavaScript with full
 * access to the page's globals. That is a reasonable thing for a self-hosted web
 * app whose operator chose to install them. It is not a reasonable thing for a
 * signed store binary: it is remote code execution by design, it crosses the
 * native bridge's trust boundary, and it is precisely what app review exists to
 * prevent.
 *
 * The guard is structural rather than behavioural. Rather than run a browser and
 * watch for a request, it reads the committed source and asserts that the only
 * place a bundle script can be created is gated on the synchronous shell
 * descriptor, and that nothing anywhere offers a way to turn that gate off.
 *
 * It deliberately does *not* fail because the separately deployed PWA bundle
 * still contains the integration framework. That framework is a browser feature
 * and stays one; what matters is that the installed shell never reaches it.
 */

import { readFileSync } from "node:fs";
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

/** The one place a community bundle script is created. */
const PROVIDER = "apps/web/src/providers/IntegrationProvider.tsx";
const provider = read(PROVIDER);

if (provider) {
  if (!provider.includes("shellFeatureBoundary")) {
    findings.push({
      file: PROVIDER,
      problem: "does not consult the shell feature boundary before loading bundles",
    });
  }
  if (!provider.includes("communityBundlesAllowed")) {
    findings.push({
      file: PROVIDER,
      problem: "has no explicit gate on community bundle loading",
    });
  }
  // The gate has to precede the loop that appends scripts, not sit inside a
  // branch the loop can skip.
  const gateIndex = provider.indexOf("if (!communityBundlesAllowed) return;");
  const createIndex = provider.indexOf('document.createElement("script")');
  if (gateIndex < 0 || (createIndex >= 0 && gateIndex > createIndex)) {
    findings.push({
      file: PROVIDER,
      problem: "the bundle gate does not run before a script element is created",
    });
  }
}

/** The boundary itself must not depend on a negotiated state. */
const BOUNDARY = "apps/web/src/lib/mobile/mobileShellEnvironment.ts";
const boundary = read(BOUNDARY);

if (boundary) {
  if (!/communityFrontendBundles:\s*false/.test(boundary)) {
    findings.push({
      file: BOUNDARY,
      problem: "the shell boundary does not disable community frontend bundles",
    });
  }
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
