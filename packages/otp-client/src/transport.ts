import type { HttpClient } from "@openmapx/integration-framework";
import type { ZodType } from "zod";
import { z } from "zod";
import { OtpError } from "./errors";

export interface OtpTransportOptions {
  http: HttpClient;
  endpoint: string;
  signal: AbortSignal;
  isSourceAllowed: () => Promise<boolean>;
}
function abortError(signal: AbortSignal): OtpError {
  return new OtpError(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
}
/** Retire even dependencies that ignore AbortSignal, without publishing their late result. */
export function bounded<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw abortError(signal);
        return run();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(abortError(signal));
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}
const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() });
export function createRequester(
  options: OtpTransportOptions,
  bindings: ReadonlyMap<unknown, { query: string; schema: ZodType }>,
) {
  async function available(signal: AbortSignal) {
    if (signal.aborted) throw abortError(signal);
    if (!(await bounded(signal, options.isSourceAllowed))) throw new OtpError("policy");
    if (signal.aborted) throw abortError(signal);
  }
  async function run<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("OTP deadline", "TimeoutError")),
      10000,
    );
    timer.unref?.();
    const combined = AbortSignal.any([options.signal, timeout.signal, ...(signal ? [signal] : [])]);
    try {
      return await bounded(combined, () => operation(combined));
    } catch (error) {
      if (combined.aborted) throw abortError(combined);
      if (error instanceof OtpError) throw error;
      throw new OtpError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    assertAvailable: () => run(undefined, available),
    request: <R, V>(document: unknown, variables?: V, signal?: AbortSignal): Promise<R> =>
      run(signal, async (combined) => {
        await available(combined);
        const binding = bindings.get(document);
        if (!binding) throw new OtpError("input");
        const response = await bounded(combined, () =>
          options.http.postResponse(
            options.endpoint,
            { query: binding.query, variables },
            {
              headers: { Accept: "application/graphql-response+json, application/json" },
              timeoutMs: 10000,
              signal: combined,
              maxBytes: 4 * 1024 * 1024,
              contentTypes: ["application/json", "application/graphql-response+json"],
              redirect: "error",
            },
          ),
        );
        await available(combined);
        if (response.status !== 200) throw new OtpError("http");
        const parsed = envelope.safeParse(response.body);
        if (!parsed.success || !("data" in parsed.data)) throw new OtpError("payload");
        if (parsed.data.errors !== undefined) throw new OtpError("graphql");
        const result = binding.schema.safeParse(parsed.data.data);
        if (!result.success) throw new OtpError("payload");
        if (combined.aborted) throw abortError(combined);
        // The SDK document and its result validator share one generated operation binding.
        return result.data as R;
      }),
  };
}
