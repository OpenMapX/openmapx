#!/usr/bin/env node
/**
 * Validates the published association files against the recorded identities.
 *
 * `--local <dir>` reads the files from a directory (the well-known service's
 * html root). Without it, they are fetched over HTTPS from the compiled origin,
 * which is the only way to catch the failures that only exist in production: a
 * redirect, a login wall, a CDN serving the wrong content type.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkAll, type LinkFinding, type PublicSigningIdentities } from "./storeLinks.ts";

const mobileRoot = resolve(import.meta.dirname, "..");

const identities = JSON.parse(
  readFileSync(resolve(mobileRoot, "release/public-signing-identities.json"), "utf8"),
) as PublicSigningIdentities;

const localIndex = process.argv.indexOf("--local");
const localDir = localIndex >= 0 ? process.argv[localIndex + 1] : null;

let files: { apple?: string; assetlinks?: string } = {};
let sourceLabel: string;

if (localDir) {
  const base = resolve(process.cwd(), localDir);
  const applePath = resolve(base, "apple-app-site-association");
  const assetPath = resolve(base, "assetlinks.json");
  files = {
    ...(existsSync(applePath) ? { apple: readFileSync(applePath, "utf8") } : {}),
    ...(existsSync(assetPath) ? { assetlinks: readFileSync(assetPath, "utf8") } : {}),
  };
  sourceLabel = base;
} else {
  const origin = identities.origin.replace(/\/$/, "");
  const fetched: Record<string, string> = {};
  for (const [key, path] of [
    ["apple", "/.well-known/apple-app-site-association"],
    ["assetlinks", "/.well-known/assetlinks.json"],
  ] as const) {
    // `redirect: "error"` on purpose: both platforms refuse a redirected
    // association file, so following one here would report a pass the OS will
    // not agree with.
    const response = await fetch(`${origin}${path}`, { redirect: "error" });
    if (!response.ok) {
      console.error(`[assert-store-links] ${path} returned HTTP ${response.status}`);
      process.exit(1);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      console.error(
        `[assert-store-links] ${path} served as "${contentType}", not application/json`,
      );
      process.exit(1);
    }
    fetched[key] = await response.text();
  }
  files = fetched;
  sourceLabel = origin;
}

const findings: LinkFinding[] = checkAll(identities, files);
const errors = findings.filter((finding) => finding.severity === "error");
const pending = findings.filter((finding) => finding.severity === "pending");

for (const finding of errors)
  console.error(`[assert-store-links] ✗ ${finding.file}: ${finding.message}`);
for (const finding of pending)
  console.log(`[assert-store-links] … ${finding.file}: ${finding.message}`);

if (errors.length > 0) process.exit(1);

if (pending.length > 0) {
  console.log(
    `\n[assert-store-links] ${sourceLabel}: structurally valid, but the identities have not been\n` +
      "issued yet. Verified links cannot work until store enrollment completes and the real\n" +
      "Team ID and Play app-signing fingerprint replace the placeholders.",
  );
  // Not a failure: this is the expected state before enrollment, and failing
  // here would mean the check can never pass until an external step happens.
  process.exit(0);
}

console.log(`[assert-store-links] ${sourceLabel}: associations match the recorded identities`);
