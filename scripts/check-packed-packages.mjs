import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "openmapx-packed-packages-"));
const artifacts = join(work, "artifacts");
const consumer = join(work, "consumer");
const env = {
  ...process.env,
  npm_config_cache: join(work, "npm-cache"),
  npm_config_update_notifier: "false",
};
function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, env, stdio: "inherit" });
}
function capture(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8" });
}
function checkTarball(file, name) {
  const paths = capture("tar", ["-tzf", file]).trim().split("\n");
  assert(paths.includes("package/README.md"), `${name}: missing consumer README`);
  assert(paths.includes("package/LICENSE"), `${name}: missing licence`);
  assert(
    !paths.some((p) => /(?:^|\/)(?:src|node_modules|\.env[^/]*)(?:\/|$)/.test(p)),
    `${name}: source/private files leaked`,
  );
  const manifest = JSON.parse(capture("tar", ["-xOf", file, "package/package.json"]));
  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    assert(
      !version.startsWith("workspace:"),
      `${name}: unresolved workspace dependency ${dependency}`,
    );
    assert(!dependency.startsWith("@openmapx/"), `${name}: requires a private host package`);
  }
  if (manifest.exports) {
    for (const value of Object.values(manifest.exports)) {
      for (const path of typeof value === "string" ? [value] : Object.values(value)) {
        assert(/^\.\/(dist|schemas)\//.test(path), `${name}: source export ${path}`);
        assert(paths.includes(`package/${path.slice(2)}`), `${name}: missing export ${path}`);
      }
    }
  }
}
try {
  mkdirSync(artifacts);
  mkdirSync(consumer);
  const contractsTarball = join(artifacts, "extension-contracts.tgz");
  const cliTarball = join(artifacts, "extension-cli.tgz");
  run("pnpm", ["--filter", "@openmapx/extension-contracts", "pack", "--out", contractsTarball]);
  run("pnpm", ["--filter", "@openmapx/extension-cli", "pack", "--out", cliTarball]);
  checkTarball(contractsTarball, "extension-contracts");
  checkTarball(cliTarball, "extension-cli");
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "openmapx-package-smoke", private: true, type: "module" }),
  );
  const install = [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ];
  run("npm", [...install, contractsTarball, cliTarball], consumer);
  writeFileSync(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { validateManifest } from "@openmapx/extension-contracts/integration";
import { validateServiceManifest } from "@openmapx/extension-contracts/service";
import { validateExtensionManifest } from "@openmapx/extension-contracts/extension";
import { validateArtifactMetadata } from "@openmapx/extension-contracts/artifact";
import { satisfiesPlatformVersion } from "@openmapx/extension-contracts/platform";
import { parseContributors } from "@openmapx/extension-contracts/contributors";
import { createAuthoringSchemas } from "@openmapx/extension-contracts/schemas";
assert(validateManifest({id:"demo",domains:["knowledge"],quality:"community"}).valid);
assert(!validateServiceManifest({id:"bad"},{firstParty:false}).valid);
assert(!validateExtensionManifest({id:"empty",name:"Empty",version:"0.1.0"}).valid);
assert(validateArtifactMetadata({schemaVersion:1,id:"demo",platformVersion:"1.0",builtAt:"1970-01-01T00:00:00Z"},"demo","1.2").valid);
assert(!satisfiesPlatformVersion("bogus"));
assert.deepEqual(parseContributors([]),[]);
assert.equal(createAuthoringSchemas().extension.type,"object");
for (const subpath of ["", "/identifiers", "/media-hosts", "/capabilities", "/licensing", "/attribution"]) {
  await import("@openmapx/extension-contracts" + subpath);
}
for (const name of ["integration", "service", "extension", "artifact"]) {
  const { default: schema } = await import("@openmapx/extension-contracts/schemas/" + name + ".json", { with: { type: "json" } });
  assert.equal(schema.type, "object");
}
`,
  );
  run(process.execPath, [join(consumer, "smoke.mjs")], consumer);
  writeFileSync(
    join(consumer, "consumer.ts"),
    `
import { validateManifest, type IntegrationManifest } from "@openmapx/extension-contracts/integration";
import { validateServiceManifest, type ServiceManifest } from "@openmapx/extension-contracts/service";
import { validateExtensionManifest, type ExtensionManifest } from "@openmapx/extension-contracts/extension";
import type { ArtifactMetadata } from "@openmapx/extension-contracts/artifact";
import type { Attribution } from "@openmapx/extension-contracts/attribution";
import { parseContributors } from "@openmapx/extension-contracts/contributors";
import { parseLicensing } from "@openmapx/extension-contracts/licensing";
const integration: IntegrationManifest = {id:"demo",domains:["knowledge"]};
const extension: ExtensionManifest = {id:"demo",name:"Demo",version:"0.1.0",services:[{repo:"https://github.com/example/demo",service:"demo"}]};
const artifact: ArtifactMetadata = {id:"demo",schemaVersion:1,platformVersion:"1.0",builtAt:"1970-01-01T00:00:00Z"};
const receipts: Attribution[] = parseContributors([]) ?? [];
validateManifest(integration); validateExtensionManifest(extension); parseLicensing(undefined);
const serviceCheck = (service: ServiceManifest) => validateServiceManifest(service, {firstParty:false});
void artifact; void receipts; void serviceCheck;
`,
  );
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  for (const [module, moduleResolution] of [
    ["NodeNext", "NodeNext"],
    ["ESNext", "Bundler"],
  ]) {
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module,
          moduleResolution,
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        files: ["consumer.ts"],
      }),
    );
    run(process.execPath, [compiler, "-p", join(consumer, "tsconfig.json")], consumer);
  }
  const cli = join(consumer, "node_modules/@openmapx/extension-cli/dist/cli.js");
  const scaffoldRoot = join(consumer, "scaffolded");
  run(process.execPath, [cli, "--help"], consumer);
  run(
    process.execPath,
    [cli, "scaffold", "integration", "packed-demo", "--domain", "knowledge", "--out", scaffoldRoot],
    consumer,
  );
  const integration = join(scaffoldRoot, "packed-demo");
  const workflow = readFileSync(join(integration, ".github/workflows/validate.yml"), "utf8");
  assert(!workflow.includes("__ID__"), "Generated CI must substitute the integration id");
  assert(workflow.includes("../packed-demo.tar.gz"), "CI must collect the generated artifact");
  const authorReadme = readFileSync(join(integration, "README.md"), "utf8");
  assert(authorReadme.startsWith("# `packed-demo`"), "README must name the generated project");
  assert(authorReadme.includes("npm ci --ignore-scripts"));
  // Exercise the documented pre-publication path with a repo-relative candidate and lockfile.
  mkdirSync(join(integration, "tools"));
  copyFileSync(cliTarball, join(integration, "tools/extension-cli.tgz"));
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-dev",
      "./tools/extension-cli.tgz",
    ],
    integration,
  );
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], integration);
  run("npm", ["run", "validate"], integration);
  const serviceDir = join(consumer, "service");
  run(
    process.execPath,
    [cli, "scaffold", "service", "packed-service", "--out", serviceDir],
    consumer,
  );
  run(
    process.execPath,
    [cli, "validate", join(serviceDir, "service.json"), "--kind", "service"],
    consumer,
  );
  run(
    process.execPath,
    [cli, "package", integration, "--out", join(artifacts, "dry-run.tar.gz"), "--dry-run"],
    consumer,
  );
  const first = join(scaffoldRoot, "packed-demo.tar.gz");
  const second = join(artifacts, "integration-b.tar.gz");
  run("npm", ["run", "package"], integration);
  run(process.execPath, [cli, "package", integration, "--out", second], consumer);
  const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  assert.equal(hash(first), hash(second), "Integration packaging must be deterministic");
  const members = capture("tar", ["-tzf", first]).trim().split("\n");
  assert(
    !members.some((p) => /(?:^|\/)(?:README\.md|\.github|tools|node_modules)(?:\/|$)/.test(p)),
    "Author instructions, CI and candidate tooling must remain outside the integration artifact",
  );
  // Match the stored member exactly; GNU tar does not normalize a leading "./" here.
  const metadata = JSON.parse(capture("tar", ["-xOf", first, "openmapx-artifact.json"]));
  assert.equal(metadata.id, "packed-demo");
  assert.equal(metadata.schemaVersion, 1);
  const source = join(consumer, "extension-input.json");
  const out = join(consumer, "extension.json");
  writeFileSync(
    source,
    JSON.stringify({
      id: "packed-extension",
      name: "Packed extension",
      version: "0.1.0",
      platform: "1.0",
      services: [
        { repo: "https://github.com/example/service", ref: "v0.1.0", service: "packed-service" },
      ],
      integrations: [
        {
          artifact: "https://example.com/integration.tar.gz",
          sha256: hash(first),
          id: "packed-demo",
        },
      ],
      config: [{ key: "DEMO", target: "service:packed-service", default: "fixture" }],
      readiness: { requires: ["service:packed-service"] },
    }),
  );
  run(process.execPath, [cli, "bundle", "--input", source, "--out", out], consumer);
  run(process.execPath, [cli, "validate", out, "--kind", "extension"], consumer);
  function rejects(args, diagnostic) {
    let failure;
    try {
      capture(process.execPath, [cli, ...args], consumer);
    } catch (error) {
      failure = error;
    }
    assert(failure && failure.status !== 0, `CLI unexpectedly accepted: ${args.join(" ")}`);
    assert.match(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, diagnostic);
  }
  rejects(["validate", out, "--kind", "unknown"], /Unsupported validation kind/);
  const badReceipts = join(consumer, "invalid-contributors.json");
  writeFileSync(badReceipts, JSON.stringify([{ name: "Missing captured provenance" }]));
  rejects(["validate", badReceipts, "--kind", "contributors"], /canonical contributor receipts/);
  const invalid = join(consumer, "invalid-extension.json");
  const untouched = join(consumer, "must-not-exist.json");
  writeFileSync(invalid, JSON.stringify({ id: "empty", name: "Empty", version: "0.1.0" }));
  rejects(["bundle", "--input", invalid, "--out", untouched], /at least one|component/i);
  assert(!existsSync(untouched), "Invalid input must not write output");
  const originalBundle = readFileSync(out, "utf8");
  for (const platform of ["0.9", "1.1", "2.0", ""]) {
    writeFileSync(source, JSON.stringify({ ...JSON.parse(originalBundle), platform }));
    rejects(["bundle", "--input", source, "--out", out], /protocol|major.minor/);
    rejects(
      [
        "bundle",
        "--id",
        "demo",
        "--name",
        "Demo",
        "--version",
        "0.1.0",
        "--platform",
        platform,
        "--service",
        "https://github.com/example/demo,v0.1.0,demo",
        "--out",
        out,
      ],
      /protocol|major.minor/,
    );
    assert.equal(
      readFileSync(out, "utf8"),
      originalBundle,
      "Rejected protocol must preserve the output",
    );
  }
  const manifestPath = join(integration, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, platform: "1.1" }));
  rejects(["validate", integration], /not compatible/);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(integration, "index.js"), "throw new Error('must never run');");
  rejects(
    ["package", integration, "--out", join(artifacts, "forbidden.tar.gz")],
    /backend|code|declarative/i,
  );
  assert(
    !existsSync(join(artifacts, "forbidden.tar.gz")),
    "Rejected code must not create an archive",
  );
  console.log(
    "Packed contracts/CLI, strict consumers, independent scaffold install, deterministic artifacts and rejection paths passed.",
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
