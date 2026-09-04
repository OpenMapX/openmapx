import type { Metadata } from "next";
import { BulkConfigure } from "@/components/admin/integrations/BulkConfigure";

export const metadata: Metadata = {
  title: "Bulk Configure — OpenMapX Admin",
};

export default function BulkConfigurePage() {
  return <BulkConfigure />;
}
