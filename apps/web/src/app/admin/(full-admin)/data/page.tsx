import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DataWorkflowsPage } from "@/components/admin/services/DataWorkflowsPage";
import { HostedDataTopics } from "@/components/admin/shared/HostedDataTopics";
import { getSelfHosted } from "@/lib/admin/serverDeployment";
export const metadata: Metadata = { title: "Data workflows — Admin — OpenMapX" };
export default async function Page() {
  const selfHosted = await getSelfHosted((await cookies()).toString());
  return selfHosted === false ? <HostedDataTopics /> : <DataWorkflowsPage />;
}
