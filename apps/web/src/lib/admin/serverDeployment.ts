import { getAdminDeployment, unwrapAdminResponse } from "@openmapx/core/api-admin-sdk";
import { createApiClient, serverApiUrl } from "@openmapx/core/server-api";

const DEPLOYMENT_READ_TIMEOUT_MS = 30_000;

/** Request cookies belong only to this request's client, never the browser singleton. */
export async function getSelfHosted(cookieHeader: string): Promise<boolean> {
  const client = createApiClient({ baseUrl: serverApiUrl(), credentials: "omit" });
  try {
    const deployment = unwrapAdminResponse(
      await getAdminDeployment({
        client,
        headers: { cookie: cookieHeader },
        cache: "no-store",
        timeoutMs: DEPLOYMENT_READ_TIMEOUT_MS,
      }),
    );
    return deployment.selfHosted;
  } catch {
    return false;
  }
}
