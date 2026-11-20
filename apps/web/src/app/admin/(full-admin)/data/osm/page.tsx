import type { Metadata } from "next";
import { DataWorkspace } from "@/components/admin/data/DataWorkspace";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("osm");
}
export default function Page() {
  return <DataWorkspace topic="osm" />;
}
