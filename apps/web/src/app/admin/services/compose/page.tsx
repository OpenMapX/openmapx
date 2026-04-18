import type { Metadata } from "next";
import { ComposePreview } from "@/components/admin/services/ComposePreview";

export const metadata: Metadata = { title: "Compose Preview — Admin — OpenMapX" };

export default function ComposePreviewPage() {
  return <ComposePreview />;
}
