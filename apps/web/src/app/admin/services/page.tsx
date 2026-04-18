import type { Metadata } from "next";
import { ServiceCatalog } from "@/components/admin/services/ServiceCatalog";

export const metadata: Metadata = { title: "Services — Admin — OpenMapX" };

export default function AdminServicesPage() {
  return <ServiceCatalog />;
}
