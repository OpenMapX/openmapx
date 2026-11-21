import type { Metadata } from "next";
import { ActivityTabs } from "@/components/admin/activity/ActivityTabs";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("activity");
}

export default function AdminActivityPage() {
  return <ActivityTabs />;
}
