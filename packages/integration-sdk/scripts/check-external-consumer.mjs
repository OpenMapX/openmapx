// Checks the SDK as an author outside the monorepo receives it: the packed
// package type-checks and imports with only its public dependencies present,
// the build inlines no third-party code, and the output imports nothing but
// zod, the public contracts package, Node built-ins, the reviewed runtime
// libraries (JavaScript only) and declared type packages (declarations only).
// Every entry point is imported, and every type it exports is named once.
import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sdkDirectory = resolve(import.meta.dirname, "..");
const contractsDirectory = join(repositoryRoot, "packages/extension-contracts");
const work = mkdtempSync(join(tmpdir(), "openmapx-integration-sdk-consumer-"));
const consumer = join(work, "consumer");
const consumerModules = join(consumer, "node_modules");
const ts = createRequire(join(sdkDirectory, "package.json"))("typescript");

const PUBLIC_PACKAGES = ["zod", "@openmapx/extension-contracts"];
// Libraries that shared helpers call at run time: address formatting
// (`./geocoding`), time-zone lookup (`./weather`), and the HTML and SPDX parsing
// behind the attribution helpers (`./attribution`, `./media`). The build leaves
// them as imports and the SDK declares them, so an author's package manager
// installs them; their code is never part of the SDK.
const RUNTIME_PACKAGES = [
  "@fragaria/address-formatter",
  "@photostructure/tz-lookup",
  "escape-html",
  "parse5",
  "spdx-expression-parse",
];
const sdkManifest = JSON.parse(readFileSync(join(sdkDirectory, "package.json"), "utf8"));
const surfaceTypes = JSON.parse(
  readFileSync(join(import.meta.dirname, "surface-types.json"), "utf8"),
);
const entryPoints = Object.keys(sdkManifest.exports).filter((key) => key !== "./package.json");
// `@types/geojson` in the SDK's dependencies lets its declarations import `geojson`.
const TYPE_PACKAGES = Object.keys(sdkManifest.dependencies)
  .filter((name) => name.startsWith("@types/"))
  .map((name) => name.slice("@types/".length));
// The declarations use Web platform globals such as `AbortSignal` and
// `RequestInit`. A backend author gets them from Node's types, which the SDK
// names as a peer, not from the DOM library.
const PEER_TYPE_PACKAGES = Object.keys(sdkManifest.peerDependencies ?? {})
  .filter((name) => name.startsWith("@types/"))
  .map((name) => name.slice("@types/".length));

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

// Looked up along Node's search paths rather than resolved, because a package
// whose `exports` leave out `./package.json` (parse5) cannot be resolved by it.
function linkInstalled(name, fromDirectory) {
  const searchPaths = createRequire(join(fromDirectory, "package.json")).resolve.paths(name) ?? [];
  const installed = searchPaths
    .map((directory) => join(directory, name))
    .find((directory) => existsSync(join(directory, "package.json")));
  if (installed === undefined)
    throw new CheckFailure(`${name} is not installed for ${fromDirectory}`);
  const target = join(consumerModules, name);
  const source = realpathSync(installed);
  // The SDK and the contracts package can both depend on the same package.
  if (existsSync(target)) {
    if (realpathSync(target) === source) return;
    throw new CheckFailure(
      `${name} is installed in two versions: ${realpathSync(target)}, ${source}`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, "dir");
}

function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Bare import specifiers of a module, read by TypeScript so comments do not count. */
function bareImports(file) {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => !specifier.startsWith("."));
}

function disallowedImports(dist) {
  const builtins = new Set(builtinModules);
  const problems = [];
  for (const file of readdirSync(dist)) {
    const declaration = file.endsWith(".d.ts");
    if (!declaration && !file.endsWith(".js")) continue;
    const allowed = new Set([
      ...PUBLIC_PACKAGES,
      ...(declaration ? TYPE_PACKAGES : RUNTIME_PACKAGES),
    ]);
    for (const specifier of bareImports(join(dist, file))) {
      if (specifier.startsWith("node:") || builtins.has(specifier)) continue;
      if (!allowed.has(packageOf(specifier))) problems.push(`${file}: ${specifier}`);
    }
  }
  return problems;
}

/** Inputs the JavaScript build read from installed packages, which it would inline. */
function thirdPartyInputs(dist) {
  const metafile = JSON.parse(readFileSync(join(dist, "metafile-esm.json"), "utf8"));
  const marker = "node_modules/";
  return Object.keys(metafile.inputs).filter((input) => {
    const at = input.lastIndexOf(marker);
    return at !== -1 && !PUBLIC_PACKAGES.includes(packageOf(input.slice(at + marker.length)));
  });
}

const failures = [];
function attempt(step) {
  try {
    step();
  } catch (error) {
    if (!(error instanceof CheckFailure)) throw error;
    failures.push(error.message);
  }
}

/** Third-party packages the SDK declares, which must be exactly the reviewed ones. */
function undeclaredDependencies() {
  const declared = Object.keys(sdkManifest.dependencies)
    .filter((name) => !name.startsWith("@openmapx/") && !name.startsWith("@types/"))
    .sort();
  const reviewed = [...PUBLIC_PACKAGES, ...RUNTIME_PACKAGES]
    .filter((name) => !name.startsWith("@openmapx/"))
    .sort();
  return JSON.stringify(declared) === JSON.stringify(reviewed)
    ? []
    : [`package.json declares ${declared.join(", ")}; reviewed: ${reviewed.join(", ")}`];
}

/**
 * One `import type` statement per entry point, naming every type it exports.
 * The compiler reports a named import the module does not export, used or not.
 */
function typeImports() {
  return Object.entries(surfaceTypes)
    .map(([entry, names], index) => {
      const specifier = `@openmapx/integration-sdk${entry.slice(1)}`;
      const bindings = names.map((name) => `${name} as T${index}_${name}`).join(", ");
      return `import type { ${bindings} } from "${specifier}";`;
    })
    .join("\n");
}

const unknownEntries = Object.keys(surfaceTypes).filter((entry) => !entryPoints.includes(entry));
if (unknownEntries.length > 0) {
  failures.push(`surface-types.json names entries the SDK does not export: ${unknownEntries}`);
}
failures.push(...undeclaredDependencies());

try {
  run("pnpm", ["--filter", "@openmapx/integration-sdk", "build"]);
  const dist = join(sdkDirectory, "dist");

  const inlined = thirdPartyInputs(dist);
  if (inlined.length > 0) {
    failures.push(
      `dist/metafile-esm.json lists ${inlined.length} inputs from installed packages, which the build may inline:\n${inlined.slice(0, 40).join("\n")}`,
    );
  }
  const imports = disallowedImports(dist);
  if (imports.length > 0) {
    failures.push(
      `dist imports packages an author does not receive with the SDK:\n${imports.join("\n")}`,
    );
  }

  mkdirSync(consumerModules, { recursive: true });
  packInto("@openmapx/integration-sdk", join(consumerModules, "@openmapx/integration-sdk"));
  packInto("@openmapx/extension-contracts", join(consumerModules, "@openmapx/extension-contracts"));
  linkInstalled("zod", sdkDirectory);
  linkInstalled("typescript", sdkDirectory);
  for (const runtimePackage of RUNTIME_PACKAGES) linkInstalled(runtimePackage, sdkDirectory);
  for (const typePackage of [...TYPE_PACKAGES, ...PEER_TYPE_PACKAGES]) {
    linkInstalled(`@types/${typePackage}`, sdkDirectory);
  }
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
import { ProviderDeclinedError, ProviderTimeoutError } from "@openmapx/integration-sdk/errors";
import { registerPlaceResolver } from "@openmapx/integration-sdk/places";
import type { DirectionsResult, RoutingProvider, TravelMode } from "@openmapx/integration-sdk/routing";
import { fetchJsonWithTimeout, forecastTimeZone } from "@openmapx/integration-sdk/weather";
import type { WeatherProvider, WeatherResponse } from "@openmapx/integration-sdk/weather";
${typeImports()}

export const weather: WeatherProvider = {
  id: "consumer-weather",
  priority: 10,
  async getCurrentWeather(coords) {
    const [lng, lat] = coords;
    const zone = forecastTimeZone(coords);
    return fetchJsonWithTimeout<WeatherResponse>(
      \`https://weather.example/current?lat=\${lat}&lng=\${lng}&tz=\${zone}\`,
    );
  },
};

export const routing: RoutingProvider = {
  id: "consumer-routing",
  supportedModes: ["driving"] satisfies TravelMode[],
  async getRoute(waypoints, mode): Promise<DirectionsResult> {
    if (waypoints.length < 2) throw new ProviderDeclinedError("unsupported");
    throw new ProviderDeclinedError("no-coverage", \`no \${mode} coverage\`);
  },
};

export function setup(ctx: IntegrationContext): void {
  registerPlaceResolver("consumer", async (id: string) => ({ id }));
  ctx.registerWeatherProvider(weather);
  ctx.registerRoutingProvider(routing);
  ctx.log.info("ready");
}

export function fail(): never {
  throw new ProviderTimeoutError();
}
`,
  );
  const compiler = join(consumerModules, "typescript/bin/tsc");
  const compile = [
    "--noEmit",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--strict",
  ];
  attempt(() => run(process.execPath, [compiler, ...compile, "provider.ts"], consumer));
  // TypeScript's default library includes the DOM, which would hide a global
  // that only a browser provides. This run sees the ECMAScript library and the
  // peer type packages, nothing else.
  attempt(() =>
    run(
      process.execPath,
      [
        compiler,
        ...compile,
        "--lib",
        "es2024",
        "--types",
        PEER_TYPE_PACKAGES.join(","),
        "provider.ts",
      ],
      consumer,
    ),
  );
  for (const entry of entryPoints) {
    attempt(() =>
      run(
        process.execPath,
        ["--input-type=module", "-e", `await import('@openmapx/integration-sdk${entry.slice(1)}')`],
        consumer,
      ),
    );
  }
} catch (error) {
  if (!(error instanceof CheckFailure)) throw error;
  failures.push(error.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length === 0) {
  console.log("external consumer: ok");
} else {
  console.error(`external consumer: failed\n\n${failures.join("\n\n")}`);
  process.exitCode = 1;
}
