import type { Metadata } from "next";
import { SystemSettings } from "@/components/admin/settings/SystemSettings";

export const metadata: Metadata = { title: "Settings — Admin — OpenMapX" };

export default function AdminSettingsPage() {
  return <SystemSettings />;
}
