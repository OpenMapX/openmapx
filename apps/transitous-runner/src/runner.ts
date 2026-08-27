import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
  CAPABILITY_TTL_MS,
  OPERATOR_METADATA_DIR,
  parseCapabilityKey,
  TRANSITOUS_RUNNER_MAX_OUTPUT_BYTES,
  TRANSITOUS_RUNNER_PROTOCOL_VERSION,
  TRANSITOUS_RUNNER_TIMEOUT_MS,
  type TransitousRunnerRequest,
  type TransitousRunnerResult,
  type TransitousRunnerScript,
  transitousRunnerArgv,
  verifyTransitousCapability,
} from "@openmapx/core/transitous-runner";

/**
 * Executes one upstream Transitous script under a fixed entrypoint.
 *
 * The runner never receives a command, a working directory, or argv from its
 * caller. It resolves the argv itself from the typed script union, runs it in
 * its own read-only catalog checkout, and bounds the run by time and output.
 */

export interface TransitousRunnerOptions {
  /** Read-only checkout of the pinned catalog. */
  catalogDir: string;
  /** Writable staging directory the scripts may produce into. */
  stagingDir: string;
  /** Shared signing key for capability tokens. Never leaves this process. */
  capabilityKey: Buffer | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnImpl?: typeof spawn;
  now?: () => number;
}

/**
 * The only variables from this container's own environment that upstream code
 * may see. Each names a path this service already mounts; none is a platform
 * credential, and the caller cannot add to the list — a request carries no
 * environment at all.
 */
const FORWARDED_ENV = ["TRANSITOUS_FEED_PROXY_KEY_FILE"] as const;

export class TransitousRunnerError extends Error {
  constructor(
    readonly reason: "authorization" | "validation" | "isolation",
    message: string,
  ) {
    super(message);
    this.name = "TransitousRunnerError";
  }
}

/**
 * Refuse a feed path that escapes the catalog. The schema already anchors the
 * shape; this proves the *resolved* path is still inside the read-only mount,
 * which is what a symlink inside the checkout could otherwise defeat.
 */
function assertInsideCatalog(catalogDir: string, relativePath: string, confinedTo?: string): void {
  if (isAbsolute(relativePath)) {
    throw new TransitousRunnerError("isolation", "Feed path must be catalog-relative");
  }
  const root = realpathSync(catalogDir);
  const candidate = resolve(root, relativePath);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new TransitousRunnerError("isolation", "Feed path escapes the catalog");
  }
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    // A feed file the catalog does not contain is a validation failure, not a
    // reason to run anything.
    throw new TransitousRunnerError("validation", "Feed path is not present in the catalog");
  }
  // Operator metadata is reached through the catalog's `downloads` symlink, so
  // its canonical path legitimately lands outside the checkout. It is then
  // confined to that one staging directory instead.
  const boundary = confinedTo === undefined ? root : realpathSync(resolve(root, confinedTo));
  if (!canonical.startsWith(`${boundary}${sep}`)) {
    throw new TransitousRunnerError("isolation", "Feed path escapes the catalog through a symlink");
  }
  if (!statSync(canonical).isFile()) {
    throw new TransitousRunnerError("validation", "Feed path is not a regular file");
  }
}

export function createTransitousRunner(options: TransitousRunnerOptions) {
  const timeoutMs = options.timeoutMs ?? TRANSITOUS_RUNNER_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? TRANSITOUS_RUNNER_MAX_OUTPUT_BYTES;
  const spawnImpl = options.spawnImpl ?? spawn;
  const now = options.now ?? (() => Date.now());

  /**
   * Nonces already honoured, with the wall-clock time they were seen. A nonce
   * only has to be remembered for as long as its token could still verify, so
   * the set is swept rather than grown without bound.
   */
  const spentNonces = new Map<string, number>();

  /** Consume a capability. A token authorizes exactly one execution. */
  function consumeCapability(capability: string, run: TransitousRunnerScript): void {
    const at = now();
    for (const [nonce, seenAt] of spentNonces) {
      if (at - seenAt > CAPABILITY_TTL_MS) spentNonces.delete(nonce);
    }
    const verified = verifyTransitousCapability(options.capabilityKey, capability, run, at);
    if (!verified.ok) {
      // The reason is deliberately not surfaced to the caller: a client that can
      // tell "forged" from "expired" learns whether it holds a real key.
      throw new TransitousRunnerError("authorization", "Capability is not valid for this run");
    }
    if (spentNonces.has(verified.nonce)) {
      throw new TransitousRunnerError("authorization", "Capability has already been used");
    }
    spentNonces.set(verified.nonce, at);
  }

  async function execute(run: TransitousRunnerScript): Promise<TransitousRunnerResult> {
    const argv = transitousRunnerArgv(run);
    if (run.script === "fetch") assertInsideCatalog(options.catalogDir, run.feedPath);
    if (run.script === "fetch-operator") {
      assertInsideCatalog(options.catalogDir, argv[1] as string, OPERATOR_METADATA_DIR);
    }
    const startedAt = Date.now();
    return await new Promise<TransitousRunnerResult>((resolvePromise) => {
      // Detached so the whole process group can be signalled: upstream scripts
      // spawn their own children, and killing only the parent would leave them
      // running past the deadline.
      const child = spawnImpl("python3", argv, {
        cwd: options.catalogDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Nothing from this service's environment is forwarded beyond the
        // declared allowlist: upstream code must never see a platform secret or
        // an agent token.
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: options.stagingDir,
          TMPDIR: options.stagingDir,
          ...Object.fromEntries(
            FORWARDED_ENV.filter((name) => process.env[name]).map((name) => [
              name,
              process.env[name] as string,
            ]),
          ),
        },
      });

      const outputChunks: Buffer[] = [];
      let capturedBytes = 0;
      let truncated = false;
      let settled = false;
      const capture = (chunk: Buffer) => {
        if (truncated) return;
        const remaining = maxOutputBytes - capturedBytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        if (chunk.byteLength > remaining) {
          outputChunks.push(chunk.subarray(0, remaining));
          capturedBytes += remaining;
          truncated = true;
        } else {
          outputChunks.push(chunk);
          capturedBytes += chunk.byteLength;
        }
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      const terminate = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        truncated = true;
        terminate();
      }, timeoutMs);

      const settle = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Child output is arbitrary bytes. Decode lossily, then bound the
        // resulting UTF-8 string too: a replacement character for a partial or
        // invalid sequence can occupy more bytes than the input it replaced.
        const decoded = Buffer.concat(outputChunks, capturedBytes).toString("utf8");
        let output = "";
        let outputBytes = 0;
        for (const character of decoded) {
          const characterBytes = Buffer.byteLength(character, "utf8");
          if (outputBytes + characterBytes > maxOutputBytes) {
            truncated = true;
            break;
          }
          output += character;
          outputBytes += characterBytes;
        }
        resolvePromise({
          version: TRANSITOUS_RUNNER_PROTOCOL_VERSION,
          ok: exitCode === 0,
          exitCode,
          output,
          truncated,
          durationMs: Date.now() - startedAt,
        });
      };
      child.on("close", (code) => settle(code ?? 1));
      child.on("error", () => settle(1));
    });
  }

  return {
    /** Validate, authorize, and run one request. */
    async run(request: TransitousRunnerRequest): Promise<TransitousRunnerResult> {
      consumeCapability(request.capability, request.run);
      return await execute(request.run);
    },
  };
}

/**
 * Load the capability signing key. The file is bind-mounted read-only into both
 * this service and its one caller, and is the sole shared secret between them.
 */
export function readCapabilityKey(path: string): Buffer {
  return parseCapabilityKey(readFileSync(path, "utf8"));
}
