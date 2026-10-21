import { createApiClient } from "@openmapx/core";
import { getAdminDeployment } from "@openmapx/core/api-admin-sdk";
import { serverApiUrl } from "@openmapx/core/server-api";
import { SERVICE_READ_TIMEOUT_MS, serviceOrThrow } from "./serviceAdmin";

/** Request cookies belong only to this request's client, never the browser singleton. */
export async function getSelfHosted(cookieHeader: string): Promise<boolean> {
  const client = createApiClient({ baseUrl: serverApiUrl(), credentials: "omit" });
  try {
    const deployment = await serviceOrThrow(
      getAdminDeployment({
        client,
        headers: { cookie: cookieHeader },
        cache: "no-store",
        timeoutMs: SERVICE_READ_TIMEOUT_MS,
      }),
    );
    return deployment.selfHosted;
  } catch {
    return false;
  }
}
