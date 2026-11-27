// Runs as the API process does (`node --import tsx/esm`) and checks that a
// bundle imported from the integration code cache shares the host's modules.
// Prints one JSON line.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProviderTimeoutError } from "@openmapx/integration-framework";
import { getPlaceResolver } from "@openmapx/place-ids";
import { ZodError, z } from "zod";
import { prepareIntegrationCodeCache } from "../../src/integration-code-cache.js";

const LARGE_BUNDLE_BYTES = 8 * 1024 * 1024;

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * zod 4 classes answer `instanceof` by a trait brand (`Symbol.hasInstance`), so
 * an error from a second zod copy still passes `instanceof ZodError`. Sharing
 * the host's prototype is what shows the bundle used the host's zod instance.
 */
function isHostZodError(error: unknown): boolean {
  const hostError = z.string().safeParse(1).error;
  return (
    error instanceof ZodError &&
    hostError !== undefined &&
    Object.getPrototypeOf(error) === Object.getPrototypeOf(hostError)
  );
}

function zodRealPath(packageDirectory: string): string {
  const require = createRequire(join(repositoryRoot, packageDirectory, "package.json"));
  return realpathSync(require.resolve("zod/package.json"));
}

/** Deterministic, incompressible-looking text of exactly `length` hex characters. */
function payloadOf(length: number): string {
  const chunks: string[] = [];
  let block = sha256("openmapx installed code loading");
  let size = 0;
  while (size < length) {
    chunks.push(block);
    size += block.length;
    block = sha256(block);
  }
  return chunks.join("").slice(0, length);
}

function largeBundle(): { bytes: Buffer; digest: string } {
  const head = 'import { createHash } from "node:crypto";\nconst payload = "';
  const tail = '";\nexport const digest = createHash("sha256").update(payload).digest("hex");\n';
  const payload = payloadOf(LARGE_BUNDLE_BYTES - head.length - tail.length);
  return { bytes: Buffer.from(head + payload + tail), digest: sha256(payload) };
}

function importUnderPlainNode(path: string): { digest: string; importMs: number } {
  const script = [
    'const { performance } = await import("node:perf_hooks");',
    "const started = performance.now();",
    "const module = await import(process.argv[1]);",
    "const importMs = performance.now() - started;",
    "process.stdout.write(JSON.stringify({ digest: module.digest, importMs }));",
  ].join("\n");
  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, pathToFileURL(path).href],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  return JSON.parse(stdout) as { digest: string; importMs: number };
}

const root = mkdtempSync(join(tmpdir(), "openmapx-integration-code-proof-"));
try {
  const cache = prepareIntegrationCodeCache({ root });

  const fixture = readFileSync(fileURLToPath(new URL("./fixture-bundle.mjs", import.meta.url)));
  const fixtureSha = sha256(fixture);
  const firstPath = cache.materialize("proof-first", fixtureSha, fixture);
  const secondPath = cache.materialize("proof-second", fixtureSha, fixture);
  const first = await import(pathToFileURL(firstPath).href);
  const second = await import(pathToFileURL(secondPath).href);

  await first.setup({});
  const resolver = getPlaceResolver("proof-scheme");
  const resolved = resolver ? await resolver("proof-scheme:1", {}) : undefined;
  const { timeout, zodError } = first.probe();

  const zodPaths = {
    api: zodRealPath("apps/api"),
    integrationFramework: zodRealPath("packages/integration-framework"),
    core: zodRealPath("packages/core"),
    integrationSdk: zodRealPath("packages/integration-sdk"),
  };
  const cacheZod = realpathSync(join(cache.root, "node_modules/zod/package.json"));

  const large = largeBundle();
  const largePath = cache.materialize("proof-large", sha256(large.bytes), large.bytes);
  const started = performance.now();
  const largeModule = await import(pathToFileURL(largePath).href);
  const largeBundleImportMs = Math.round(performance.now() - started);
  const plain = importUnderPlainNode(largePath);

  console.log(
    JSON.stringify({
      timeoutIsHostClass: timeout instanceof ProviderTimeoutError,
      zodErrorIsHostClass: isHostZodError(zodError),
      singleZod: new Set([...Object.values(zodPaths), cacheZod]).size === 1,
      resolverVisibleToHost:
        (resolved as { resolvedBy?: string } | undefined)?.resolvedBy === "fixture-bundle",
      sameBytesTwoIdsAreDistinctModules:
        firstPath !== secondPath && first !== second && first.probe !== second.probe,
      largeBundleDigestMatches:
        largeModule.digest === large.digest && plain.digest === large.digest,
      largeBundleImportMs,
      largeBundlePlainNodeImportMs: Math.round(plain.importMs),
      largeBundleBytes: large.bytes.length,
      zodPaths: { ...zodPaths, cache: cacheZod },
      node: process.version,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
