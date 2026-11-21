import type { Metadata } from "next";
import { BulkConfigure } from "@/components/admin/integrations/BulkConfigure";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("bulkConfigure");
}

export default function BulkConfigurePage() {
  return <BulkConfigure />;
}
