import { createApiClient, serverApiUrl } from "@openmapx/core/server-api";
import {
  type PublicShare,
  resolvePublicShare,
  SHARE_TOKEN_PATTERN,
} from "@openmapx/core/sharing-sdk";

export type PublicShareResult =
  | { status: "ok"; share: PublicShare }
  | { status: "not-found" }
  | { status: "unavailable" };

/** Anonymous, request-local client: never inherit browser cookies or interceptors. */
export async function loadPublicShare(token: string): Promise<PublicShareResult> {
  if (!new RegExp(SHARE_TOKEN_PATTERN).test(token)) return { status: "not-found" };
  try {
    const result = await resolvePublicShare(token, {
      client: createApiClient({ baseUrl: serverApiUrl(), credentials: "omit" }),
      cache: "no-store",
    });
    if (result.status === 404) return { status: "not-found" };
    if (result.status !== 200) return { status: "unavailable" };
    return { status: "ok", share: result.data };
  } catch {
    return { status: "unavailable" };
  }
}
