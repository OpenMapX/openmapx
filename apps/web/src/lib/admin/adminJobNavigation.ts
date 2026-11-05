import type { AdminActivityJobSource } from "@openmapx/core/api-contracts";

import { safeAdminNavigationReturn } from "./adminNavigation";

const boundedId = (id: string | null): id is string =>
  !!id &&
  id.trim().length > 0 &&
  id.length <= 256 &&
  !Array.from(id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
export function safeAdminJobReturn(value: string | null | undefined): string | null {
  return safeAdminNavigationReturn(value);
}

export function parseAdminJobSelection(
  params: Pick<URLSearchParams, "get">,
): { id: string; source: AdminActivityJobSource; returnTo: string | null } | null {
  const id = params.get("job"),
    source = params.get("source");
  if (!boundedId(id) || (source !== "application" && source !== "data-manager")) return null;
  return { id, source, returnTo: safeAdminJobReturn(params.get("returnTo")) };
}
export function adminJobHref({
  id,
  source,
  returnTo,
}: {
  id: string;
  source: AdminActivityJobSource;
  returnTo?: string;
}): string {
  if (!boundedId(id) || (source !== "application" && source !== "data-manager"))
    return "/admin/activity?tab=jobs";
  const params = new URLSearchParams({ tab: "jobs", job: id, source });
  const safeReturn = safeAdminJobReturn(returnTo);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/admin/activity?${params.toString()}`;
}
