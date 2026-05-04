import type { Metadata } from "next";
import StatusDashboard from "./StatusDashboard";

export const metadata: Metadata = {
  title: "System Status — OpenMapX",
  robots: "noindex",
};

export default function StatusPage() {
  return (
    <div className="h-dvh overflow-auto bg-gray-50 dark:bg-neutral-950 px-4 py-8">
      <StatusDashboard />
    </div>
  );
}
