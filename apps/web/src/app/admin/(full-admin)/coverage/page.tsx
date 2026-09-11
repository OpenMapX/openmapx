import type { Metadata } from "next";
import { CoveragePage } from "@/components/admin/coverage/CoveragePage";

export const metadata: Metadata = { title: "Coverage & freshness — Admin — OpenMapX" };

export default function AdminCoveragePage() {
  return <CoveragePage />;
}
