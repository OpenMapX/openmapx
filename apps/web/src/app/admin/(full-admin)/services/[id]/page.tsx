import { redirect } from "next/navigation";
import { legacyAdminHref } from "@/lib/admin/adminNavigation";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  redirect(legacyAdminHref(`/admin/services/${encodeURIComponent(id)}`, await searchParams));
}
