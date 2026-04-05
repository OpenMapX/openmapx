import type { Metadata } from "next";
import { DataWorkflowsPage } from "@/components/admin/services/DataWorkflowsPage";

export const metadata: Metadata = { title: "Data Workflows — Admin — OpenMapX" };

export default function AdminDataWorkflowsPage() {
  return <DataWorkflowsPage />;
}
