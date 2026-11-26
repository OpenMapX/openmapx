// Checks the SDK as an author outside the monorepo receives it: the packed
// package type-checks and imports with only its public dependencies present,
// and the build carries no browser or auth library and no private host import.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sdkDirectory = resolve(import.meta.dirname, "..");
const contractsDirectory = join(repositoryRoot, "packages/extension-contracts");
const work = mkdtempSync(join(tmpdir(), "openmapx-integration-sdk-consumer-"));
const consumer = join(work, "consumer");
const consumerModules = join(consumer, "node_modules");

const FORBIDDEN_INPUTS = [
  "node_modules/react/",
  "node_modules/zustand/",
  "node_modules/@tanstack/react-query/",
  "node_modules/better-auth/",
];
const PUBLIC_HOST_PACKAGE = "@openmapx/extension-contracts";

class CheckFailure extends Error {}

function run(command, args, cwd = repositoryRoot) {
  const printable = [command, ...args].join(" ");
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new CheckFailure(`${printable} (in ${cwd})\n${output}`);
  }
}

function packInto(packageName, destination) {
  const tarball = join(work, `${packageName.replace("@openmapx/", "")}.tgz`);
  run("pnpm", ["--filter", packageName, "pack", "--out", tarball]);
  const extracted = join(work, `${packageName.replace("@openmapx/", "")}-extracted`);
  mkdirSync(extracted);
  run("tar", ["-xzf", tarball, "-C", extracted]);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(join(extracted, "package"), destination);
}

function linkInstalled(name, fromDirectory) {
  const manifest = createRequire(join(fromDirectory, "package.json")).resolve(
    `${name}/package.json`,
  );
  const target = join(consumerModules, name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(realpathSync(dirname(manifest)), target, "dir");
}

function privateHostImports(file) {
  const text = readFileSync(file, "utf8");
  const specifiers = text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](@openmapx\/[^"']+)["']/g);
  return [...specifiers]
    .map((match) => match[1])
    .filter(
      (specifier) =>
        specifier !== PUBLIC_HOST_PACKAGE && !specifier.startsWith(`${PUBLIC_HOST_PACKAGE}/`),
    );
}

try {
  run("pnpm", ["--filter", "@openmapx/integration-sdk", "build"]);
  mkdirSync(consumerModules, { recursive: true });
  packInto("@openmapx/integration-sdk", join(consumerModules, "@openmapx/integration-sdk"));
  packInto("@openmapx/extension-contracts", join(consumerModules, "@openmapx/extension-contracts"));
  linkInstalled("zod", sdkDirectory);
  linkInstalled("typescript", sdkDirectory);
  for (const dependency of Object.keys(
    JSON.parse(readFileSync(join(contractsDirectory, "package.json"), "utf8")).dependencies,
  )) {
    if (dependency !== "zod") linkInstalled(dependency, contractsDirectory);
  }

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "integration-sdk-consumer", private: true, type: "module" }),
  );
  writeFileSync(
    join(consumer, "provider.ts"),
    `import type { IntegrationContext } from "@openmapx/integration-sdk";
import { ProviderTimeoutError } from "@openmapx/integration-sdk/errors";
import { registerPlaceResolver } from "@openmapx/integration-sdk/places";

export function setup(ctx: IntegrationContext): void {
  registerPlaceResolver("consumer", async (id: string) => ({ id }));
  ctx.log.info("ready");
}

export function fail(): never {
  throw new ProviderTimeoutError();
}
`,
  );
  const compiler = join(consumerModules, "typescript/bin/tsc");
  run(
    process.execPath,
    [
      compiler,
      "--noEmit",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--strict",
      "provider.ts",
    ],
    consumer,
  );
  run(process.execPath, ["-e", "import('@openmapx/integration-sdk/errors')"], consumer);

  const dist = join(sdkDirectory, "dist");
  const metafile = JSON.parse(readFileSync(join(dist, "metafile-esm.json"), "utf8"));
  const forbidden = Object.keys(metafile.inputs).filter((input) =>
    FORBIDDEN_INPUTS.some((fragment) => input.includes(fragment)),
  );
  if (forbidden.length > 0) {
    throw new CheckFailure(
      `dist/metafile-esm.json lists browser or auth inputs:\n${forbidden.join("\n")}`,
    );
  }
  const leaks = readdirSync(dist)
    .filter((file) => file.endsWith(".js") || file.endsWith(".d.ts"))
    .flatMap((file) => privateHostImports(join(dist, file)).map((spec) => `${file}: ${spec}`));
  if (leaks.length > 0) {
    throw new CheckFailure(`dist still imports private host packages:\n${leaks.join("\n")}`);
  }
  console.log("external consumer: ok");
} catch (error) {
  if (!(error instanceof CheckFailure)) throw error;
  console.error(`external consumer: failed\n${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
