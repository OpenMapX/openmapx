import { readFileSync } from "node:fs";
import {
  mintTransitousCapability,
  parseCapabilityKey,
  TRANSITOUS_RUNNER_PROTOCOL_VERSION,
  TRANSITOUS_RUNNER_TIMEOUT_MS,
  type TransitousRunnerScript,
  transitousRunnerResultSchema,
} from "@openmapx/core/transitous-runner";
import { scrubSecrets } from "../../utils/scrub-secrets.js";

/**
 * Client for the private Transitous runner.
 *
 * Upstream Transitous is third-party Python. It used to execute inside this
 * service, which owns `/data`, the database, Redis, and the ops-agent token.
 * The pipeline now names a script and its validated arguments; the runner —
 * a separate container with no platform authority — decides the argv and runs
 * it. Nothing in a request can widen what executes.
 */

export type TransitousScriptRunner = (run: TransitousRunnerScript) => Promise<void>;

export class TransitousScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitousScriptError";
  }
}

export interface TransitousScriptRunnerOptions {
  /** Base URL of the runner service; empty means "not deployed". */
  baseUrl: string;
  capabilityKey: Buffer | Uint8Array;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function describe(run: TransitousRunnerScript): string {
  return run.script === "fetch" ? `${run.script} ${run.feedPath}` : run.script;
}

export function createTransitousScriptRunner(
  options: TransitousScriptRunnerOptions,
): TransitousScriptRunner {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (run) => {
    if (!options.baseUrl) {
      throw new TransitousScriptError(
        "The private Transitous runner is not configured (TRANSITOUS_RUNNER_URL); refusing to execute upstream scripts in this service",
      );
    }

    // The capability is minted at dispatch, not at queue time: it authorizes
    // this one run and expires within minutes.
    const capability = mintTransitousCapability(options.capabilityKey, { now: now(), run });
    const controller = new AbortController();
    // Slightly beyond the runner's own ceiling so its bounded result, not a
    // client abort, is what the pipeline sees for a script that overruns.
    const timer = setTimeout(() => controller.abort(), TRANSITOUS_RUNNER_TIMEOUT_MS + 30_000);

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: TRANSITOUS_RUNNER_PROTOCOL_VERSION,
          capability,
          run,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // The request body carries a live capability; only the reason is safe to
      // repeat, never the request itself.
      throw new TransitousScriptError(
        `Transitous runner is unreachable for ${describe(run)}: ${scrubSecrets((error as Error).message)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new TransitousScriptError(
        `Transitous runner refused ${describe(run)} (HTTP ${response.status})`,
      );
    }

    const parsed = transitousRunnerResultSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new TransitousScriptError(
        `Transitous runner returned an unexpected response for ${describe(run)}`,
      );
    }
    if (!parsed.data.ok) {
      // The output is the script's own stderr, which downstream failure
      // attribution parses. It is scrubbed first: a feed URL in it can carry an
      // API key, and this message reaches operator alerting.
      const output = scrubSecrets(parsed.data.output).trim();
      throw new TransitousScriptError(
        `${describe(run)} exited ${parsed.data.exitCode}${output ? `: ${output}` : ""}`,
      );
    }
  };
}

/**
 * Build the runner client this deployment uses. Reads the shared capability
 * key from the bind-mounted secret; an absent key leaves the client configured
 * but unusable, which surfaces as a stage error rather than a silent fallback
 * to in-process execution.
 */
export function createDefaultTransitousScriptRunner(): TransitousScriptRunner {
  const baseUrl = process.env.TRANSITOUS_RUNNER_URL ?? "";
  const keyFile = process.env.TRANSITOUS_RUNNER_CAPABILITY_KEY_FILE ?? "";
  let capabilityKey: Uint8Array = Buffer.alloc(0);
  if (keyFile) {
    try {
      capabilityKey = parseCapabilityKey(readFileSync(keyFile, "utf8"));
    } catch {
      // Leave the key empty: every dispatch then fails authorization at the
      // runner, which is the correct outcome for a missing secret.
    }
  }
  return createTransitousScriptRunner({ baseUrl, capabilityKey });
}
