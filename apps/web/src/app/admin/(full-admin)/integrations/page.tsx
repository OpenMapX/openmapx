import type { Metadata } from "next";
import { IntegrationList } from "@/components/admin/integrations/IntegrationList";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("integrations");
}

export default function AdminIntegrationsPage() {
  return <IntegrationList />;
}
