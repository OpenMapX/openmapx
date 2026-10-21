import { serverApiUrl } from "@openmapx/core/server-api";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { getSelfHosted } from "@/lib/admin/serverDeployment";

async function getAdminSession() {
  const cookieStore = await cookies();
  const res = await fetch(`${serverApiUrl()}/api/me`, {
    headers: { cookie: cookieStore.toString() },
    cache: "no-store",
  });

  if (!res.ok) return null;
  return res.json() as Promise<{
    user: { name: string; email: string; image?: string; role?: string };
  }>;
}

export default async function AdminRootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const session = await getAdminSession();

  if (session?.user.role !== "admin" && session?.user.role !== "privacy_admin") {
    redirect("/");
  }

  const selfHosted = session.user.role === "admin" ? await getSelfHosted(cookieHeader) : false;

  return (
    <AdminLayout user={session.user} selfHosted={selfHosted}>
      {children}
    </AdminLayout>
  );
}
