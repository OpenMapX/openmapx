import type { Metadata } from "next";
import { ActivityTabs } from "@/components/admin/activity/ActivityTabs";

export const metadata: Metadata = { title: "Activity — Admin — OpenMapX" };

export default function AdminActivityPage() {
  return <ActivityTabs />;
}
