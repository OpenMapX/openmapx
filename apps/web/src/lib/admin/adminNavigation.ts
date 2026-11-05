import { adminQueryHref } from "./adminNavigationState";
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
  label: string;
  description: string;
  href: string;
  workspace: AdminWorkspace;
  access: "admin" | "privacy";
  hostOnly?: boolean;
  keywords?: readonly string[];
}
export interface AdminNavigationAccess {
  role?: string;
  selfHosted?: boolean | null;
}
const destination = (
  id: string,
  label: string,
  description: string,
  href: string,
  workspace: AdminWorkspace,
  hostOnly = false,
): AdminDestination => ({ id, label, description, href, workspace, hostOnly, access: "admin" });
/** Literal destinations are also the allowlist for privileged return navigation. */
export const ADMIN_DESTINATIONS: readonly AdminDestination[] = [
  destination("overview", "Overview", "Attention, health and current work", "/admin", "overview"),
  destination(
    "integrations",
    "Integrations",
    "Providers, configuration and credentials",
    "/admin/integrations",
    "integrations",
  ),
  destination(
    "extensions",
    "Extensions",
    "Discover and manage installed extensions",
    "/admin/extensions",
    "extensions",
  ),
  destination("data", "Data", "Acquire, build and maintain map data", "/admin/data", "data"),
  destination(
    "osm",
    "OSM",
    "Extracts, builds and OpenStreetMap acquisition",
    "/admin/data/osm",
    "data",
    true,
  ),
  destination(
    "overture",
    "Overture",
    "Places release, conflation and recovery",
    "/admin/data/overture",
    "data",
    true,
  ),
  destination(
    "search",
    "Search & places",
    "Search index, ambient and notable places",
    "/admin/data/search",
    "data",
    true,
  ),
  destination(
    "transit",
    "Transit",
    "Pipeline, catalog and feed credentials",
    "/admin/data/transit",
    "data",
  ),
  destination(
    "coverage",
    "Coverage & freshness",
    "Inspect available data and its evidence",
    "/admin/data/coverage",
    "data",
  ),
  destination(
    "transfers",
    "Prepared transfers",
    "Review, stage and transfer data artifacts",
    "/admin/data/transfers",
    "data",
    true,
  ),
  destination(
    "operations",
    "Advanced operations",
    "Full updates, hardlink sync and destructive cleanup",
    "/admin/data/operations",
    "data",
    true,
  ),
  destination("users", "Users", "Accounts, sessions and recovery", "/admin/users", "users"),
  {
    ...destination(
      "privacy",
      "Privacy requests",
      "Review and fulfil privacy cases",
      "/admin/privacy",
      "privacy",
    ),
    access: "privacy",
  },
  destination(
    "privacy-setup",
    "Privacy setup",
    "Operator, policies and readiness reviews",
    "/admin/privacy-setup",
    "privacy",
  ),
  destination(
    "activity",
    "Activity",
    "Jobs, audit events and application logs",
    "/admin/activity",
    "activity",
  ),
  destination(
    "general",
    "General",
    "Application identity and public instance URL",
    "/admin/settings/general",
    "settings",
  ),
  destination(
    "authentication",
    "Authentication",
    "Sign-in, sessions and effective access policy",
    "/admin/settings/authentication",
    "settings",
  ),
  destination(
    "email",
    "Email",
    "Senders, delivery providers and a test message",
    "/admin/settings/email",
    "settings",
  ),
  destination(
    "map",
    "Map",
    "Map presentation and provider settings",
    "/admin/settings/map",
    "settings",
  ),
  destination(
    "data-use",
    "Data use",
    "Application data-use policy",
    "/admin/settings/data-use",
    "settings",
  ),
  destination(
    "services",
    "Services",
    "Inspect and operate application services",
    "/admin/system/services",
    "system",
    true,
  ),
  destination(
    "deployment",
    "Deployment",
    "Persistent service selection, origin and host configuration",
    "/admin/system/deployment",
    "system",
    true,
  ),
  destination(
    "updates",
    "Updates",
    "Check and update the OpenMapX release",
    "/admin/system/updates",
    "system",
    true,
  ),
  destination(
    "backups",
    "Backups",
    "Create, inspect and restore backups",
    "/admin/system/backups",
    "system",
    true,
  ),
  destination(
    "diagnostics",
    "Diagnostics",
    "Inspect host readiness and run deep checks",
    "/admin/system/diagnostics",
    "system",
    true,
  ),
  destination(
    "cache",
    "Cache",
    "Inspect and clear application caches",
    "/admin/system/cache",
    "system",
  ),
  destination(
    "configuration-transfer",
    "Configuration transfer",
    "Export, import and migrate configuration",
    "/admin/system/configuration-transfer",
    "system",
  ),
];
export function adminDestinations({ role = "admin", selfHosted = null }: AdminNavigationAccess) {
  return ADMIN_DESTINATIONS.filter(
    (entry) =>
      (role === "admin" || (role === "privacy_admin" && entry.access === "privacy")) &&
      (!entry.hostOnly || selfHosted !== false),
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
    return entry
      ? [{ ...entry, id: workspace, label: workspace[0].toUpperCase() + workspace.slice(1) }]
      : [];
  });
}
const LEGACY_PATHS: Record<string, string> = {
  "/admin/services": "/admin/system/services",
  "/admin/services/compose": "/admin/system/deployment",
  "/admin/services/data": "/admin/data",
  "/admin/services/backups": "/admin/system/backups",
  "/admin/transit": "/admin/data/transit",
  "/admin/coverage": "/admin/data/coverage",
  "/admin/cache": "/admin/system/cache",
  "/admin/settings": "/admin/settings/general",
};
export function legacyAdminHref(
  path: string,
  query: Record<string, string | string[] | undefined> = {},
  selfHosted: boolean | null = null,
) {
  const target =
    path === "/admin/system"
      ? selfHosted === false
        ? "/admin/system/cache"
        : "/admin/system/updates"
      : (LEGACY_PATHS[path] ?? path.replace(/^\/admin\/services\//, "/admin/system/services/"));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (typeof value === "string") params.set(key, value);
  return adminQueryHref(target, params, {});
}
export function adminWorkspaceForPath(path: string): AdminWorkspace | null {
  const canonical = legacyAdminHref(path);
  return (
    [...ADMIN_DESTINATIONS]
      .sort((a, b) => b.href.length - a.href.length)
      .find(
        (entry) =>
          canonical === entry.href ||
          (entry.href !== "/admin" && canonical.startsWith(`${entry.href}/`)),
      )?.workspace ?? null
  );
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
  if (/^\/admin\/(system\/)?services\/[^/]+$/.test(path)) return SERVICE_TABS;
  if (/^\/admin\/users\/[^/]+$/.test(path)) return ["profile", "sessions", "accounts"];
  if (/^\/admin\/integrations\/[^/]+$/.test(path))
    return ["overview", "configuration", "credentials", "health", "sources"];
  if (path === "/admin/activity") return ["jobs", "audit", "logs"];
  if (path === "/admin/extensions") return ["browse", "installed", "sources", "local"];
  if (path === "/admin/data/transit" || path === "/admin/transit")
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
    const detail = /^\/admin\/(?:system\/services|services|integrations|users)\/([^/]+)$/.exec(
      url.pathname,
    );
    const id = detail ? decodeURIComponent(detail[1]) : null;
    const known =
      ADMIN_DESTINATIONS.some((entry) => entry.href === url.pathname) ||
      Object.hasOwn(LEGACY_PATHS, url.pathname) ||
      url.pathname === "/admin/system" ||
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
