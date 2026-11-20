import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DataWorkspace } from "@/components/admin/data/DataWorkspace";
import { HostedDataTopics } from "@/components/admin/shared/HostedDataTopics";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
import { getSelfHosted } from "@/lib/admin/serverDeployment";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("data");
}
export default async function Page() {
  const selfHosted = await getSelfHosted((await cookies()).toString());
  return selfHosted === false ? <HostedDataTopics /> : <DataWorkspace />;
}
