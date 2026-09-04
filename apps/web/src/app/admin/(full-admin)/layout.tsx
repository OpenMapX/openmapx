import { serverApiUrl } from "@openmapx/core/server-api";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

/** The pathless group contains the existing broad administration surface. */
export default async function FullAdminLayout({ children }: { children: ReactNode }) {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}/api/me`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  if (!response.ok) redirect("/");
  const session = (await response.json()) as { user?: { role?: string } };
  if (session.user?.role !== "admin") redirect("/admin/privacy");
  return children;
}
