import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DataWorkspace } from "@/components/admin/data/DataWorkspace";
import { HostedDataTopics } from "@/components/admin/shared/HostedDataTopics";
import { getSelfHosted } from "@/lib/admin/serverDeployment";
export const metadata: Metadata = { title: "Data — Admin — OpenMapX" };
export default async function Page() {
  const selfHosted = await getSelfHosted((await cookies()).toString());
  return selfHosted === false ? <HostedDataTopics /> : <DataWorkspace />;
}
