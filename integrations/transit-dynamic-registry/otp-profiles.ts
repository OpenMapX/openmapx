import { createHash } from "node:crypto";
import type { HttpResponse, UpstreamRuntime } from "@openmapx/integration-framework";
import { type GtfsFamily, OtpError } from "@openmapx/otp-client";
import type { RegistryEntry } from "./registry-types";

export interface OtpProfile {
  readonly id: string;
  readonly family: GtfsFamily | "trufi";
  readonly catalogEndpoint: string;
  readonly endpoint: string;
  readonly sourceId: string;
  readonly keyed?: true;
}
const profiles: OtpProfile[] = [
  {
    id: "de/stadtnavi-otp",
    family: "stadtnavi",
    catalogEndpoint: "https://api.stadtnavi.de/routing/v1/router/",
    endpoint: "https://api.stadtnavi.de/otp/gtfs/v1",
    sourceId: "stadtnavi",
  },
  {
    id: "ee/peatus-otp",
    family: "peatus",
    catalogEndpoint: "https://api.peatus.ee/routing/v1/routers/estonia/",
    endpoint: "https://api.peatus.ee/routing/v1/routers/estonia/index/graphql",
    sourceId: "peatus",
  },
  {
    id: "it/torino-otp",
    family: "torino",
    catalogEndpoint: "https://mapi.5t.torino.it/routing/v1/routers/mat/",
    endpoint: "https://mapi.5t.torino.it/routing/v1/routers/mat/index/graphql",
    sourceId: "torino",
  },
  {
    id: "bo/trufi-cochabamba-2-otp",
    family: "trufi",
    catalogEndpoint: "https://otp281.trufi.app/otp/transmodel/v3",
    endpoint: "https://otp281.trufi.app/otp/transmodel/v3",
    sourceId: "trufi",
  },
  ...["finland", "hsl", "varely", "waltti"].map(
    (region, index): OtpProfile => ({
      id: ["fi/digitransit-otp", "fi/helsinki-otp", "fi/varely-otp", "fi/waltti-otp"][index],
      family: "digitransit",
      catalogEndpoint: `https://api.digitransit.fi/routing/v2/${region}/gtfs/v1`,
      endpoint: `https://api.digitransit.fi/routing/v2/${region}/gtfs/v1`,
      sourceId: "digitransit",
      keyed: true,
    }),
  ),
];
export const OTP_PROFILES: readonly OtpProfile[] = Object.freeze(
  profiles.map((profile) => Object.freeze(profile)),
);
export function resolveOtpProfile(entry: RegistryEntry): OtpProfile {
  const profile = OTP_PROFILES.find((p) => p.id === entry.id);
  if (
    !profile ||
    entry.protocol !== "otpGraphQl" ||
    entry.options.endpoint !== profile.catalogEndpoint
  )
    throw new OtpError("configuration");
  return profile;
}
/** Credential digest partitions a shared cooldown; it is never a password verifier. */
export function publicOtpPolicy(
  profile: OtpProfile,
  apiKey: unknown,
  runtime: UpstreamRuntime | undefined,
) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (profile.keyed && (!key || key.length > 512 || /[^\x21-\x7e]/.test(key)))
    throw new OtpError("unconfigured");
  const identity = {
    scope: new URL(profile.endpoint).origin,
    key: profile.keyed ? createHash("sha256").update(key).digest("hex") : "anonymous",
  };
  const admit = runtime?.admitSharedRequest?.bind(runtime);
  const defer = runtime?.deferSharedRequests?.bind(runtime);
  return {
    headers: profile.keyed ? { "digitransit-subscription-key": key } : undefined,
    async beforeRequest(signal: AbortSignal) {
      if (!admit || !defer) throw new OtpError("unavailable");
      const result = await admit({ ...identity, signal });
      if (!result.allowed)
        throw new OtpError(result.reason === "store_unavailable" ? "unavailable" : "quota");
    },
    async afterResponse(response: HttpResponse<unknown>, signal: AbortSignal) {
      if (response.status !== 429) return;
      if (!defer) throw new OtpError("unavailable");
      const raw = response.headers["retry-after"];
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
      const serverDate = Date.parse(response.headers.date ?? "");
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(raw ?? "") - (Number.isFinite(serverDate) ? serverDate : Date.now());
      // Missing/invalid Retry-After gets a conservative one-minute cooldown, not a quota allowance.
      const delayMs =
        Number.isSafeInteger(delay) && delay > 0 && Number.isSafeInteger(Date.now() + delay)
          ? delay
          : 60000;
      await defer({ ...identity, delayMs, signal });
      throw new OtpError("quota");
    },
  };
}
