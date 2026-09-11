import { readBoundedResponseText } from "@openmapx/core";
import { services } from "@openmapx/core/server";

export interface TrafficPolicy {
  revision: string;
  validUntil: string;
  disallowedSourceIds: string[];
}

/** Read the existing deployment authority; never grant a lease after a failed read. */
export async function fetchTrafficPolicy(
  options: { baseUrl?: string; token?: string; fetch?: typeof fetch } = {},
): Promise<TrafficPolicy> {
  const base = services.validateDataManagerBaseUrl(
    options.baseUrl ?? process.env.APP_API_BASE_URL ?? "http://app-api:3001",
    { allowPlaintextHosts: ["app-api"] },
  );
  const token = options.token ?? process.env.DATA_MANAGER_AUTH_TOKEN;
  if (!token) throw new Error("Road-condition policy service authentication unavailable");
  const response = await (options.fetch ?? fetch)(
    `${base}/api/data-manager/road-conditions/policy`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error(`Road-condition policy HTTP ${response.status}`);
  const body = JSON.parse(
    await readBoundedResponseText(response, 256 * 1024, { label: "road-condition policy" }),
  ) as Record<string, unknown>;
  const until = typeof body.validUntil === "string" ? Date.parse(body.validUntil) : NaN;
  if (
    body.schemaVersion !== 1 ||
    body.authoritative !== true ||
    typeof body.revision !== "string" ||
    !body.revision ||
    !Number.isFinite(until) ||
    until <= Date.now() ||
    until > Date.now() + 150_000 ||
    !Array.isArray(body.disallowedSourceIds) ||
    body.disallowedSourceIds.length > 10_000 ||
    !body.disallowedSourceIds.every((id) => typeof id === "string" && id.length <= 256)
  )
    throw new Error("Road-condition policy lease unavailable or invalid");
  return {
    revision: body.revision,
    validUntil: body.validUntil as string,
    disallowedSourceIds: body.disallowedSourceIds as string[],
  };
}
