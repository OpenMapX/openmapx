import type { Metadata } from "next";
import { DataWorkspace } from "@/components/admin/data/DataWorkspace";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("search");
}
export default function Page() {
  return <DataWorkspace topic="search" />;
}
