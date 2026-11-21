import type { Metadata } from "next";
import { CoveragePage } from "@/components/admin/coverage/CoveragePage";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("coverage");
}
export default function Page() {
  return <CoveragePage />;
}
