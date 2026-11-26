import type { AdminOverview } from "@openmapx/core/api-contracts";

export type AttentionItem = AdminOverview["attention"][number];

/** Where an overview attention item leads; a stored item's link never leaves the admin area. */
export function attentionHref(item: AttentionItem): string {
  if (item.type === "missing_credentials" || item.type === "health_check_failed") {
    return `/admin/integrations/${item.target}`;
  }
  if (item.type === "job_failed") return "/admin/activity";
  if (item.type === "service_unhealthy") return "/admin/system/services";
  if (item.type === "stored") return item.target?.startsWith("/admin") ? item.target : "/admin";
  return "/admin";
}
