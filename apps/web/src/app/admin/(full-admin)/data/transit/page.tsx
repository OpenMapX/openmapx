import type { Metadata } from "next";
import { TransitWorkspace } from "@/components/admin/transit/TransitWorkspace";
export const metadata: Metadata = { title: "Transit — Admin — OpenMapX" };
export default function Page() {
  return <TransitWorkspace />;
}
