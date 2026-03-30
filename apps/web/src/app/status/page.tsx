import type { Metadata } from "next";
import StatusDashboard from "./StatusDashboard";

export const metadata: Metadata = {
  title: "System Status — OpenMapX",
  robots: "noindex",
};

export default function StatusPage() {
  return <StatusDashboard />;
}
