import type { Metadata } from "next";
import { DataWorkspace } from "@/components/admin/data/DataWorkspace";
export const metadata: Metadata = { title: "Prepared transfers — Admin — OpenMapX" };
export default function Page() {
  return <DataWorkspace topic="transfers" />;
}
