import type { Metadata } from "next";
import { ServiceCatalog } from "@/components/admin/services/ServiceCatalog";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("services");
}
export default function Page() {
  return <ServiceCatalog />;
}
