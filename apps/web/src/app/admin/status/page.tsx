import type { Metadata } from "next";
import StatusDashboard from "@/app/status/StatusDashboard";

export const metadata: Metadata = { title: "Status — Admin — OpenMapX" };

export default function AdminStatusPage() {
  return <StatusDashboard />;
}
