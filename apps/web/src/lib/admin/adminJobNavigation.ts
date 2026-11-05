import type { AdminActivityJobSource } from "@openmapx/core/api-contracts";

const destinations = new Set([
  "/admin",
  "/admin/users",
  "/admin/privacy",
  "/admin/privacy-setup",
  "/admin/integrations",
  "/admin/extensions",
  "/admin/services",
  "/admin/services/compose",
  "/admin/services/backups",
  "/admin/services/data",
  "/admin/transit",
  "/admin/coverage",
  "/admin/activity",
  "/admin/settings",
  "/admin/system",
  "/admin/cache",
]);
const boundedId = (id: string | null): id is string =>
  !!id &&
  id.trim().length > 0 &&
  id.length <= 256 &&
  !Array.from(id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
export function safeAdminJobReturn(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/admin") || value.includes("\\"))
    return null;
  try {
    const url = new URL(value, "https://admin.invalid");
    if (url.origin !== "https://admin.invalid" || url.hash || value.split("?")[0] !== url.pathname)
      return null;
    const detail = /^\/admin\/(services|integrations|users)\/([^/]+)$/.exec(url.pathname);
    if (
      !destinations.has(url.pathname) &&
      (!detail ||
        !boundedId(decodeURIComponent(detail[2])) ||
        /[/\\]/.test(decodeURIComponent(detail[2])))
    )
      return null;
    if ([...url.searchParams.keys()].some((key) => key !== "tab")) return null;
    const tab = url.searchParams.get("tab");
    if (
      tab &&
      ![
        "overview",
        "configuration",
        "credentials",
        "health",
        "sources",
        "profile",
        "sessions",
        "accounts",
        "logs",
        "manifest",
        "browse",
        "installed",
        "local",
        "jobs",
        "audit",
      ].includes(tab)
    )
      return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
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
    throw new Error("Invalid administration job identity");
  const params = new URLSearchParams({ tab: "jobs", job: id, source });
  const safeReturn = safeAdminJobReturn(returnTo);
  if (safeReturn) params.set("returnTo", safeReturn);
  return `/admin/activity?${params.toString()}`;
}
