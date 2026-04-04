import type { Metadata } from "next";
import { IntegrationDetail } from "@/components/admin/integrations/IntegrationDetail";

export const metadata: Metadata = { title: "Integration Detail — Admin — OpenMapX" };

export default async function AdminIntegrationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <IntegrationDetail id={id} />;
}
