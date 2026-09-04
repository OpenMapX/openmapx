import type { Metadata } from "next";
import { IntegrationList } from "@/components/admin/integrations/IntegrationList";

export const metadata: Metadata = { title: "Integrations — Admin — OpenMapX" };

export default function AdminIntegrationsPage() {
  return <IntegrationList />;
}
