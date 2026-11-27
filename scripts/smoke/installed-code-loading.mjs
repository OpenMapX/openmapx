// Runs inside the API image, piped to `node --import tsx/esm --input-type=module -`
// from the API's working directory, as the API's own user. It lays out an
// integration code cache the way the API does and checks that a bundle imported
// from it shares the host's SDK, zod and place resolver registry. The image
// holds the bundled server, not the cache module's source, so the layout is
// rebuilt here. Diagnostics go to stderr; the last stdout line is the verdict.
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProviderTimeoutError } from "@openmapx/integration-framework";
import { getPlaceResolver } from "@openmapx/place-ids";
import { ZodError, z } from "zod";

const FIXTURE = `import { ProviderTimeoutError } from "@openmapx/integration-sdk/errors";
import { registerPlaceResolver } from "@openmapx/integration-sdk/places";
import { z } from "zod";

export async function setup(_ctx) {
  registerPlaceResolver("proof-scheme", async (id) => ({ id, resolvedBy: "fixture-bundle" }));
}

export function probe() {
  let zodError;
  try {
    z.string().parse(1);
  } catch (error) {
    zodError = error;
  }
  return { timeout: new ProviderTimeoutError(), zodError };
}
`;

function packageRoot(entry, name) {
  let directory = dirname(entry);
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === name) {
        return directory;
      }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`No package root named ${name} above ${entry}`);
    directory = parent;
  }
}

function materialize(root, integrationId, bytes) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, integrationId, sha256);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "index.mjs");
  writeFileSync(path, bytes, { mode: 0o400, flag: "wx" });
  return path;
}

const hostRequire = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
const root = mkdtempSync(join(tmpdir(), "openmapx-integration-code-smoke-"));
let result;
try {
  chmodSync(root, 0o700);
  const sdk = realpathSync(dirname(hostRequire.resolve("@openmapx/integration-sdk/package.json")));
  const zod = realpathSync(
    packageRoot(createRequire(join(sdk, "package.json")).resolve("zod"), "zod"),
  );
  mkdirSync(join(root, "node_modules", "@openmapx"), { recursive: true, mode: 0o700 });
  symlinkSync(sdk, join(root, "node_modules", "@openmapx", "integration-sdk"), "dir");
  symlinkSync(zod, join(root, "node_modules", "zod"), "dir");

  const bytes = Buffer.from(FIXTURE);
  const firstPath = materialize(root, "proof-first", bytes);
  const secondPath = materialize(root, "proof-second", bytes);
  const first = await import(pathToFileURL(firstPath).href);
  const second = await import(pathToFileURL(secondPath).href);
  await first.setup({});
  const resolver = getPlaceResolver("proof-scheme");
  const resolved = resolver ? await resolver("proof-scheme:1", {}) : undefined;
  const { timeout, zodError } = first.probe();
  const hostZodError = z.string().safeParse(1).error;

  result = {
    timeoutIsHostClass: timeout instanceof ProviderTimeoutError,
    // zod 4 answers instanceof by a trait brand; the prototype shows the instance.
    zodErrorIsHostClass:
      zodError instanceof ZodError &&
      Object.getPrototypeOf(zodError) === Object.getPrototypeOf(hostZodError),
    singleZod: zod === realpathSync(packageRoot(hostRequire.resolve("zod"), "zod")),
    resolverVisibleToHost: resolved?.resolvedBy === "fixture-bundle",
    sameBytesTwoIdsAreDistinctModules: first !== second && first.probe !== second.probe,
  };
  console.error(JSON.stringify({ ...result, uid: process.getuid?.(), root, sdk, zod }));
} catch (error) {
  console.error(error);
} finally {
  rmSync(root, { recursive: true, force: true });
}
const ok = result !== undefined && Object.values(result).every((value) => value === true);
console.log(JSON.stringify({ ok }));
