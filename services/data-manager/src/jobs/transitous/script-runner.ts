import { readFileSync } from "node:fs";
import { setTimeout as runnerDelay } from "node:timers/promises";
import {
  mintTransitousCapability,
  parseCapabilityKey,
  TRANSITOUS_RUNNER_PROTOCOL_VERSION,
  TRANSITOUS_RUNNER_TIMEOUT_MS,
  type TransitousRunnerScript,
  transitousRunnerResultSchema,
  transitousRunnerStatusSchema,
} from "@openmapx/core/transitous-runner";
import { scrubSecrets } from "../../utils/scrub-secrets.js";
import type { DataExecutionContext } from "../execution/runtime.js";
import { dataExecutionWorkerContext, dataWorkerSignal } from "../execution/worker-scope.js";

async function runnerResponseBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Runner response missing");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 8 * 1024 * 1024) {
        await reader.cancel();
        throw Error("Runner response capacity exceeded");
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

/** Recovery uses only the signed original pending requests. The capability
 * authorizes cancel/inspect after expiry, never another execution POST. */
export async function cancelAndSettleRetainedTransitousScripts(
  context: DataExecutionContext,
): Promise<"settled" | "pending"> {
  const journal = context.store.controlJournal;
  if (!journal) throw Error("Original runner journal required");
  const attempts = journal.pendingRunnerAttempts(context.authority);
  if (!attempts.length) return "settled";
  const endpoint = process.env.TRANSITOUS_RUNNER_URL?.replace(/\/+$/, "");
  if (!endpoint) return "pending";
  const signal = AbortSignal.timeout(30000);
  let pending = false;
  for (const request of attempts) {
    const control = async (action: "cancel" | "inspect" | "acknowledge") => {
      const response = await fetch(`${endpoint}/v1/run/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) throw Error("Original runner outcome is unknown");
      return runnerResponseBody(response);
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          await control("cancel");
        } catch {
          /* Lost cancel response permits only exact observation. */
        }
        const state = transitousRunnerStatusSchema.parse(await control("inspect"));
        if (state.state === "terminal") {
          journal.completeRunnerAttempt(context.authority, request, state.result);
          try {
            await control("acknowledge");
          } catch {
            /* Original result is retained. */
          }
          break;
        }
        await runnerDelay(100, undefined, { signal });
      }
    } catch {
      pending = true;
    }
  }
  return pending ? "pending" : "settled";
}

/**
 * Client for the private Transitous runner.
 *
 * Upstream Transitous is third-party Python. It used to execute inside this
 * service, which owns `/data`, the database, and the ops-agent token.
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
    const controller = new AbortController(),
      workerSignal = dataWorkerSignal(),
      context = dataExecutionWorkerContext(),
      request = { version: TRANSITOUS_RUNNER_PROTOCOL_VERSION, capability, run };
    const journal = context?.store.controlJournal;
    if (context && !journal) throw Error("Retained runner owner is unavailable");
    journal?.retainRunnerAttempt(context!.authority, request);
    const timer = setTimeout(() => controller.abort(), TRANSITOUS_RUNNER_TIMEOUT_MS + 30000),
      signal = workerSignal
        ? AbortSignal.any([workerSignal, controller.signal])
        : controller.signal;
    const endpoint = options.baseUrl.replace(/\/+$/, "");
    const control = async (
      action: "inspect" | "cancel" | "acknowledge",
      settlement: AbortSignal,
    ) => {
      const response = await fetchImpl(`${endpoint}/v1/run/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: settlement,
      });
      if (!response.ok) throw Error("Original runner outcome is unknown");
      return runnerResponseBody(response);
    };
    let result: unknown,
      remoteContained = false;
    try {
      try {
        const response = await fetchImpl(`${endpoint}/v1/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal,
        });
        if (!response.ok) throw Error(`Runner HTTP ${response.status}`);
        result = await runnerResponseBody(response);
      } catch (error) {
        if (!context && !signal.aborted) throw error; // Standalone client tests have no durable platform owner.
        const settlement = AbortSignal.timeout(30000);
        for (;;) {
          settlement.throwIfAborted();
          if (signal.aborted)
            try {
              await control("cancel", settlement);
            } catch {
              /* Retry cancellation only, never execution. */
            }
          const state = transitousRunnerStatusSchema.parse(await control("inspect", settlement));
          if (state.state === "terminal") {
            result = state.result;
            break;
          }
          await runnerDelay(100, undefined, { signal: settlement });
        }
      }
      const checked = transitousRunnerResultSchema.safeParse(result);
      if (!checked.success)
        throw new TransitousScriptError(
          `Transitous runner returned an unexpected response for ${describe(run)}`,
        );
      const parsed = checked.data;
      journal?.completeRunnerAttempt(context!.authority, request, parsed);
      remoteContained = true;
      if (context)
        try {
          await control("acknowledge", AbortSignal.timeout(5000));
        } catch {
          /* Original contained result is already retained locally. */
        }
      if (signal.aborted) signal.throwIfAborted();
      result = parsed;
    } catch (error) {
      if (context && !remoteContained) await context.checkpoint({ publication: "unknown" });
      throw new TransitousScriptError(
        `Transitous runner outcome is unresolved for ${describe(run)}: ${scrubSecrets((error as Error).message)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const parsed = transitousRunnerResultSchema.safeParse(result);
    if (!parsed.success)
      throw new TransitousScriptError(
        `Transitous runner returned an unexpected response for ${describe(run)}`,
      );
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
  const runner = createTransitousScriptRunner({ baseUrl, capabilityKey });
  return async (run) => {
    if (!dataExecutionWorkerContext())
      throw new TransitousScriptError("Durable transit worker ownership is required");
    return runner(run);
  };
}
