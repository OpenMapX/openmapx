export const SETTINGS_TOPICS = ["general", "authentication", "email", "map", "data-use"] as const;

export type AdminWorkspace =
  | "overview"
  | "integrations"
  | "extensions"
  | "data"
  | "users"
  | "privacy"
  | "activity"
  | "settings"
  | "system";
export interface AdminDestination {
  id: string;
  href: string;
  workspace: AdminWorkspace;
  hostOnly?: boolean;
}
export interface AdminNavigationAccess {
  role?: string;
  selfHosted?: boolean | null;
}
/** Labels and descriptions live in the `adminNavigation.destinations` catalogue under the id. */
const destination = (
  id: string,
  href: string,
  workspace: AdminWorkspace,
  hostOnly = false,
): AdminDestination => ({ id, href, workspace, hostOnly });
/** Literal destinations are also the allowlist for privileged return navigation. */
export const ADMIN_DESTINATIONS: readonly AdminDestination[] = [
  destination("overview", "/admin", "overview"),
  destination("integrations", "/admin/integrations", "integrations"),
  destination("extensions", "/admin/extensions", "extensions"),
  destination("data", "/admin/data", "data"),
  destination("osm", "/admin/data/osm", "data", true),
  destination("overture", "/admin/data/overture", "data", true),
  destination("search", "/admin/data/search", "data", true),
  destination("transit", "/admin/data/transit", "data"),
  destination("coverage", "/admin/data/coverage", "data"),
  destination("transfers", "/admin/data/transfers", "data", true),
  destination("operations", "/admin/data/operations", "data", true),
  destination("users", "/admin/users", "users"),
  destination("privacy", "/admin/privacy", "privacy"),
  destination("privacy-setup", "/admin/privacy-setup", "privacy"),
  destination("activity", "/admin/activity", "activity"),
  destination("general", "/admin/settings/general", "settings"),
  destination("authentication", "/admin/settings/authentication", "settings"),
  destination("email", "/admin/settings/email", "settings"),
  destination("map", "/admin/settings/map", "settings"),
  destination("data-use", "/admin/settings/data-use", "settings"),
  destination("services", "/admin/system/services", "system", true),
  destination("deployment", "/admin/system/deployment", "system", true),
  destination("updates", "/admin/system/updates", "system", true),
  destination("backups", "/admin/system/backups", "system", true),
  destination("diagnostics", "/admin/system/diagnostics", "system", true),
  destination("cache", "/admin/system/cache", "system"),
  destination("configuration-transfer", "/admin/system/configuration-transfer", "system"),
];
export function adminDestinations({ role = "admin", selfHosted = null }: AdminNavigationAccess) {
  return ADMIN_DESTINATIONS.filter(
    (entry) => role === "admin" && (!entry.hostOnly || selfHosted !== false),
  );
}
export function adminPrimaryNavigation(access: AdminNavigationAccess) {
  const visible = adminDestinations(access);
  return (
    [
      "overview",
      "integrations",
      "extensions",
      "data",
      "users",
      "privacy",
      "activity",
      "settings",
      "system",
    ] as const
  ).flatMap((workspace) => {
    const entry = visible.find((item) => item.workspace === workspace);
    return entry ? [{ ...entry, id: workspace }] : [];
  });
}
export function adminWorkspaceForPath(path: string): AdminWorkspace | null {
  return adminDestinationForPath(path)?.workspace ?? null;
}
export function adminDestinationForPath(path: string) {
  return [...ADMIN_DESTINATIONS]
    .sort((a, b) => b.href.length - a.href.length)
    .find(
      (entry) =>
        path === entry.href || (entry.href !== "/admin" && path.startsWith(`${entry.href}/`)),
    );
}
const SERVICE_TABS = ["overview", "configuration", "credentials", "logs", "manifest"];
export function adminTabsForPath(path: string): readonly string[] {
  if (/^\/admin\/system\/services\/[^/]+$/.test(path)) return SERVICE_TABS;
  if (/^\/admin\/users\/[^/]+$/.test(path)) return ["profile", "sessions", "accounts"];
  if (/^\/admin\/integrations\/[^/]+$/.test(path))
    return ["overview", "configuration", "credentials", "health", "sources"];
  if (path === "/admin/activity") return ["jobs", "audit", "logs"];
  if (path === "/admin/extensions") return ["browse", "installed", "sources", "local"];
  if (path === "/admin/data/transit")
    return ["sources", "catalog", "credentials", "pipeline", "mobility"];
  return [];
}
export function safeAdminNavigationReturn(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/admin") || value.includes("\\"))
    return null;
  try {
    const url = new URL(value, "https://admin.invalid");
    if (url.origin !== "https://admin.invalid" || url.hash || value.split("?")[0] !== url.pathname)
      return null;
    const detail = /^\/admin\/(?:system\/services|integrations|users)\/([^/]+)$/.exec(url.pathname);
    const encodedId = detail?.[1];
    const id = encodedId === undefined ? null : decodeURIComponent(encodedId);
    const known =
      ADMIN_DESTINATIONS.some((entry) => entry.href === url.pathname) ||
      url.pathname === "/admin/integrations/bulk";
    if (
      !known &&
      (!id || id.length > 128 || !/^[a-zA-Z0-9_.~-]+$/.test(id) || id === "." || id === "..")
    )
      return null;
    if (
      [...url.searchParams.keys()].some((key) => key !== "tab") ||
      url.searchParams.getAll("tab").length > 1
    )
      return null;
    const tab = url.searchParams.get("tab");
    if (tab !== null && !adminTabsForPath(url.pathname).includes(tab)) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}
