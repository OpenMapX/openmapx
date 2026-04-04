import type { Metadata } from "next";
import { ServicesPage } from "@/components/admin/services/ServicesPage";

export const metadata: Metadata = { title: "Services — Admin — OpenMapX" };

export default function AdminServicesPage() {
  return <ServicesPage />;
}
