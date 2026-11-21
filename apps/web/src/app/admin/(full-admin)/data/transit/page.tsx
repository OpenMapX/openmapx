import type { Metadata } from "next";
import { TransitWorkspace } from "@/components/admin/transit/TransitWorkspace";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("transit");
}
export default function Page() {
  return <TransitWorkspace />;
}
