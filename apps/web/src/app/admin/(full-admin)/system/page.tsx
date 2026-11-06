import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { legacyAdminHref } from "@/lib/admin/adminNavigation";
import { getSelfHosted } from "@/lib/admin/serverDeployment";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const jar = await cookies();
  redirect(
    legacyAdminHref("/admin/system", await searchParams, await getSelfHosted(jar.toString())),
  );
}
