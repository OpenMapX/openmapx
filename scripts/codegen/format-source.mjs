import { execFileSync, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const cwd = fileURLToPath(new URL("../../", import.meta.url));

/** Apply the same formatter and import organization as repository checks. */
export function formatSource(filename, content) {
  return execFileSync(
    process.execPath,
    [biome, "check", "--write", "--linter-enabled=false", "--stdin-file-path", filename],
    { cwd, input: content, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
}

// The official CLI synchronously starts the native formatter. Own both in a
// separate POSIX group, including when the wrapper exits before its child.
async function runBiomeBatch(args) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Contained batch formatting requires Darwin or Linux process groups.");
  const child = spawn(process.execPath, args, { cwd, detached: true, stdio: "pipe" });
  const buffers = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  const maxBuffer = 16 * 1024 * 1024;
  let failure;
  const groupHasLiveMembers = () => {
    const output = execFileSync("ps", ["-axo", "pgid=,stat="], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer,
    }).trim();
    const states = output.split("\n").map((line) => line.trim().split(/\s+/));
    // An empty or malformed process listing cannot establish termination.
    if (states.some(([group, state, extra]) => !/^\d+$/.test(group) || !state || extra))
      throw new Error("Could not inspect the Biome process group.");
    return states.some(([group, state]) => Number(group) === child.pid && !state.startsWith("Z"));
  };
  const killGroup = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code === "ESRCH") return;
      // Darwin reports EPERM for a retained zombie-only group. Accept it only
      // after inspection proves there is no member that can still run/write.
      if (error.code === "EPERM" && !groupHasLiveMembers()) return;
      throw error;
    }
  };
  const stop = (error) => {
    failure ??= error;
    try {
      killGroup();
    } catch (cleanupError) {
      failure = new AggregateError([failure, cleanupError], "Could not stop the Biome group.");
    }
  };
  const closed = new Promise((resolve) => {
    child.once("error", stop);
    child.once("exit", (code, signal) => {
      // Do this on exit, not close: a surviving native child holds the pipes.
      if (code !== 0 || signal)
        stop(Object.assign(new Error(`Biome exited with ${signal ?? code}.`), { code, signal }));
      else stop();
    });
    child.once("close", resolve);
  });
  const deadline = setTimeout(
    () =>
      stop(Object.assign(new Error("Biome batch formatting timed out."), { code: "ETIMEDOUT" })),
    90_000,
  );
  for (const stream of ["stdout", "stderr"]) {
    child[stream]?.on("data", (chunk) => {
      sizes[stream] += chunk.length;
      if (sizes[stream] > maxBuffer) {
        stop(
          Object.assign(new Error(`Biome ${stream} exceeded ${maxBuffer} bytes.`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
      } else buffers[stream].push(chunk);
    });
  }
  try {
    await closed;
    // close drains the inherited pipes. Also check the owned group, so even a
    // descendant that closed its pipes cannot race the caller's scratch cleanup.
    // Retained zombies cannot run or write, on either supported POSIX platform.
    while (child.pid) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") break;
        if (error.code === "EPERM" && !groupHasLiveMembers()) break;
        throw error;
      }
      if (!groupHasLiveMembers()) break;
      await delay(5);
    }
  } finally {
    clearTimeout(deadline);
  }
  if (failure) throw failure;
  return Buffer.concat(buffers.stdout).toString("utf8");
}

/** Format only collected files in an Orval-owned generation scratch directory. */
export async function formatSourceFiles(sourceDirectory, paths) {
  const directory = realpathSync(sourceDirectory);
  if (
    directory !== resolve(sourceDirectory) ||
    !/^\.superpowers\/(api-sdk|data-manager-sdk|entur-geocoder|mbta)\/generation-[^/]+\/generated$/.test(
      relative(cwd, directory).split(sep).join("/"),
    )
  )
    throw new Error("Batch formatting requires generator-owned scratch.");

  // Stdin formatting had no on-disk size limit. Include the largest artifact
  // rather than letting Biome silently skip files above its default one MiB.
  let maxSize = 1024 * 1024;
  for (const path of paths) {
    if (!resolve(path).startsWith(`${directory}${sep}`) || realpathSync(path) !== resolve(path))
      throw new Error(`Artifact is outside owned scratch or is a symbolic link: ${path}`);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
    // Biome 2.5.15 excludes files whose size equals the configured limit too.
    maxSize = Math.max(maxSize, stat.size + 1);
  }
  if (!paths.length) return;

  const { summary } = JSON.parse(
    await runBiomeBatch([
      biome,
      "check",
      "--write",
      "--linter-enabled=false",
      "--vcs-enabled=false",
      "--files-ignore-unknown=false",
      `--files-max-size=${maxSize}`,
      "--error-on-warnings",
      "--reporter=json",
      ...paths,
    ]),
  );
  // The pinned CLI's summary accounts for every file, including already clean
  // ones. A successful exit alone can conceal config-excluded/unsupported files.
  if (
    summary.errors !== 0 ||
    summary.warnings !== 0 ||
    summary.skipped !== 0 ||
    summary.changed + summary.unchanged !== paths.length
  )
    throw new Error(`Biome did not format all ${paths.length} generated artifacts.`);
}
