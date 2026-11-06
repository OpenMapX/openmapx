import { redirect } from "next/navigation";
import { legacyAdminHref } from "@/lib/admin/adminNavigation";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(legacyAdminHref("/admin/cache", await searchParams));
}
