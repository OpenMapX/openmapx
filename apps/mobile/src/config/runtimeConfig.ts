import Constants from "expo-constants";
import { z } from "zod";

/**
 * The build-time configuration as the running app sees it.
 *
 * `app.config.ts` validates the inputs and copies the non-secret subset into
 * `extra.mobile`; this module reads it back and re-validates. The duplication is
 * deliberate: a corrupted or tampered manifest must fail loudly at startup
 * rather than silently produce an app pointed somewhere else.
 *
 * There is no setter. Nothing in the app — not a deep link, not a bridge
 * message, not a preference — can change these values at runtime.
 */
const runtimeConfigSchema = z
  .object({
    release: z.boolean(),
    feasibilityMode: z.boolean(),
    webOrigin: z.url(),
    apiOrigin: z.url(),
    webHost: z.string().min(1),
    appId: z.string().min(1),
    scheme: z.string().min(1),
  })
  .strict();

export type MobileRuntimeConfig = Readonly<z.infer<typeof runtimeConfigSchema>>;

export class MobileConfigError extends Error {}

let cached: MobileRuntimeConfig | null = null;

/** Parses an arbitrary `extra.mobile` value. Exported for tests. */
export function parseRuntimeConfig(value: unknown): MobileRuntimeConfig {
  const parsed = runtimeConfigSchema.safeParse(value);
  if (!parsed.success) {
    // The failure message must not echo the input: it could contain a
    // maliciously crafted origin that then lands in a log.
    throw new MobileConfigError("the compiled mobile configuration is missing or malformed");
  }
  for (const origin of [parsed.data.webOrigin, parsed.data.apiOrigin]) {
    const url = new URL(origin);
    if (url.origin !== origin) {
      throw new MobileConfigError(
        "mobile origins must contain only scheme, host, and optional port",
      );
    }
    if (parsed.data.release && url.protocol !== "https:") {
      throw new MobileConfigError("release origins require HTTPS");
    }
  }
  return Object.freeze(parsed.data);
}

export function getRuntimeConfig(): MobileRuntimeConfig {
  cached ??= parseRuntimeConfig(Constants.expoConfig?.extra?.mobile);
  return cached;
}

/** Test seam: clears the memoised value so a suite can supply another manifest. */
export function resetRuntimeConfigCache(): void {
  cached = null;
}
