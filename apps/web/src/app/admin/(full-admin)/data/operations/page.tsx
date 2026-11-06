import type { Metadata } from "next";
import { DataWorkspace } from "@/components/admin/data/DataWorkspace";
export const metadata: Metadata = { title: "Advanced operations — Admin — OpenMapX" };
export default function Page() {
  return <DataWorkspace topic="operations" />;
}
