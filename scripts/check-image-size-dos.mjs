#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROBE_TIMEOUT_MS = 2_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const require = createRequire(import.meta.url);

function fixtureBytes(name) {
  switch (name) {
    case "icns":
      return new Uint8Array([
        0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10, 0x69, 0x63, 0x30, 0x37, 0x00, 0x00, 0x00,
        0x00,
      ]);
    case "jxl":
      return new Uint8Array([
        0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 0x00, 0x00, 0x00,
        0x14, 0x66, 0x74, 0x79, 0x70, 0x6a, 0x78, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x78,
        0x6c, 0x20, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x70, 0x00, 0x00, 0x00, 0x00,
      ]);
    case "heif":
      return new Uint8Array([
        0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x30, 0x6d, 0x65, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x24, 0x69, 0x70, 0x72, 0x70, 0x00, 0x00, 0x00, 0x1c, 0x69, 0x70, 0x63, 0x6f, 0x00,
        0x00, 0x00, 0x00, 0x69, 0x73, 0x70, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
      ]);
    default:
      throw new Error(`Unknown fixture: ${name}`);
  }
}

function packageDirectory(storeDirectory, lockfilePath, version) {
  const lockfile = readFileSync(lockfilePath, "utf8");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patchHashes = new Set(
    Array.from(
      lockfile.matchAll(
        new RegExp(`image-size@${escapedVersion}\\(patch_hash=([a-f0-9]+)\\)`, "g"),
      ),
      (match) => match[1],
    ),
  );
  if (patchHashes.size > 1) {
    throw new Error(`Lockfile ${lockfilePath} contains multiple image-size@${version} patches`);
  }
  const [patchHash] = patchHashes;
  const exactEntryName = patchHash
    ? `image-size@${version}_patch_hash=${patchHash}`
    : `image-size@${version}`;
  const matches = readdirSync(storeDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === exactEntryName)
    .map((entry) => join(storeDirectory, entry.name, "node_modules/image-size"))
    .filter((directory) => {
      if (!existsSync(directory)) return false;
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      return manifest.name === "image-size" && manifest.version === version;
    });

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one installed image-size@${version} below ${storeDirectory}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function parserFromModule(module, payload) {
  if (payload.entryKind === "root" || payload.entryKind === "lookup") {
    const parser = module.imageSize ?? module.default ?? module;
    if (typeof parser !== "function") {
      throw new TypeError(`${payload.label} does not export an image parser`);
    }
    return (input) => parser(input);
  }
  if (payload.entryKind === "from-file") {
    if (typeof module.imageSizeFromFile !== "function") {
      throw new TypeError(`${payload.label} does not export imageSizeFromFile`);
    }
    return (_input, fixturePath) => module.imageSizeFromFile(fixturePath);
  }
  if (payload.entryKind === "types-index") {
    const handler =
      module.typeHandlers instanceof Map
        ? module.typeHandlers.get(payload.fixture)
        : module.typeHandlers?.[payload.fixture];
    if (typeof handler?.calculate !== "function") {
      throw new TypeError(`${payload.label} does not export the ${payload.fixture} handler`);
    }
    return (input) => handler.calculate(input);
  }
  const handler = module[payload.fixture.toUpperCase()];
  if (typeof handler?.calculate !== "function") {
    throw new TypeError(`${payload.label} does not export the ${payload.fixture} handler`);
  }
  return (input) => handler.calculate(input);
}

async function runWorker(payload) {
  const module =
    payload.moduleKind === "esm"
      ? await import(`${pathToFileURL(payload.entryPath).href}?dos-probe=${process.pid}`)
      : require(payload.entryPath);
  const parser = parserFromModule(module, payload);
  const input = fixtureBytes(payload.fixture);

  if (payload.fixturePath) {
    writeFileSync(payload.fixturePath, input, { mode: 0o600 });
  }

  try {
    await parser(input, payload.fixturePath);
    process.stdout.write('{"status":"safe-result"}\n');
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        status: "safe-parse-error",
        error: error instanceof Error ? error.name : "non-error",
      })}\n`,
    );
  }
}

function runProbe(probe) {
  return new Promise((resolveProbe, rejectProbe) => {
    const temporaryDirectory =
      probe.entryKind === "from-file"
        ? mkdtempSync(join(tmpdir(), "openmapx-image-size-probe-"))
        : undefined;
    const fixturePath = temporaryDirectory
      ? join(temporaryDirectory, `${probe.fixture}.bin`)
      : undefined;
    const payload = { ...probe, fixturePath };
    const child = spawn(process.execPath, [SCRIPT_PATH, "--worker", JSON.stringify(payload)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-4_096);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_096);
    });

    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);

    child.once("error", (error) => {
      clearTimeout(deadline);
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
      rejectProbe(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (temporaryDirectory) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
        if (existsSync(temporaryDirectory)) {
          rejectProbe(new Error(`${probe.label} left its temporary directory behind`));
          return;
        }
      }
      if (timedOut) {
        rejectProbe(
          new Error(`${probe.label} timed out after ${PROBE_TIMEOUT_MS}ms (isolated child killed)`),
        );
        return;
      }
      if (signal || code !== 0) {
        rejectProbe(
          new Error(
            `${probe.label} crashed unexpectedly (code=${code}, signal=${signal}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        rejectProbe(
          new Error(`${probe.label} returned an invalid worker result: ${stdout.trim()}`),
        );
        return;
      }
      if (result.status !== "safe-result" && result.status !== "safe-parse-error") {
        rejectProbe(new Error(`${probe.label} returned an unexpected status: ${result.status}`));
        return;
      }
      resolveProbe();
    });
  });
}

function probesFor(packageRoot, version) {
  const fixtures = ["icns", "jxl", "heif"];
  const probes = [];
  const add = (relativePath, moduleKind, entryKind, fixture) => {
    const entryPath = join(packageRoot, relativePath);
    if (!existsSync(entryPath)) {
      throw new Error(`Missing image-size@${version} probe entry: ${entryPath}`);
    }
    probes.push({
      entryKind,
      entryPath,
      fixture,
      label: `image-size@${version} ${relativePath} (${fixture})`,
      moduleKind,
    });
  };

  for (const fixture of fixtures) {
    for (const moduleKind of ["cjs", "esm"]) {
      const extension = moduleKind === "cjs" ? "cjs" : "mjs";
      add(`dist/fromFile.${extension}`, moduleKind, "from-file", fixture);
      add(`dist/index.${extension}`, moduleKind, "root", fixture);
      add(`dist/lookup.${extension}`, moduleKind, "lookup", fixture);
      add(`dist/types/index.${extension}`, moduleKind, "types-index", fixture);
      add(`dist/types/${fixture}.${extension}`, moduleKind, "type", fixture);
    }
  }
  return probes;
}

async function main() {
  const docsPackage = packageDirectory(
    join(REPOSITORY_ROOT, "docs/node_modules/.pnpm"),
    join(REPOSITORY_ROOT, "docs/pnpm-lock.yaml"),
    "2.0.2",
  );
  const probes = probesFor(docsPackage, "2.0.2");

  for (const probe of probes) {
    await runProbe(probe);
  }
  console.log(`✓ image-size DoS probes terminated safely (${probes.length} entry/fixture cases)`);
}

if (process.argv[2] === "--worker") {
  runWorker(JSON.parse(process.argv[3])).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
