import type { Metadata } from "next";
import { IntegrationDetail } from "@/components/admin/integrations/IntegrationDetail";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("integrationDetail");
}

export default async function AdminIntegrationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <IntegrationDetail id={id} />;
}
