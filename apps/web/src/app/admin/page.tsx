import type { Metadata } from "next";
import { AdminOverview } from "@/components/admin/overview/AdminOverview";

export const metadata: Metadata = { title: "Overview — Admin — OpenMapX" };

export default function AdminPage() {
  return <AdminOverview />;
}
