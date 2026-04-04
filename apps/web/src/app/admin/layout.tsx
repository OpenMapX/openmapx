import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";

async function getAdminSession() {
  const cookieStore = await cookies();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const res = await fetch(`${apiUrl}/api/me`, {
    headers: { cookie: cookieStore.toString() },
    cache: "no-store",
  });

  if (!res.ok) return null;
  return res.json() as Promise<{
    user: { name: string; email: string; image?: string; role?: string };
  }>;
}

async function getSelfHosted(cookieHeader: string): Promise<boolean> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  try {
    const res = await fetch(`${apiUrl}/api/admin/deployment`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { selfHosted?: boolean };
    return data.selfHosted === true;
  } catch {
    return false;
  }
}

export default async function AdminRootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const [session, selfHosted] = await Promise.all([getAdminSession(), getSelfHosted(cookieHeader)]);

  if (!session || session.user.role !== "admin") {
    redirect("/");
  }

  return (
    <AdminLayout user={session.user} selfHosted={selfHosted}>
      {children}
    </AdminLayout>
  );
}
