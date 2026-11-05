import type { Metadata } from "next";
import { TransitPipelinePage } from "@/components/admin/transit/TransitPipelinePage";
export const metadata: Metadata = { title: "Transit — Admin — OpenMapX" };
export default function Page() {
  return <TransitPipelinePage />;
}
