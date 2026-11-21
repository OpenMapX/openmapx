import type { Metadata } from "next";
import { AdminOverview } from "@/components/admin/overview/AdminOverview";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("overview");
}

export default function AdminPage() {
  return <AdminOverview />;
}
