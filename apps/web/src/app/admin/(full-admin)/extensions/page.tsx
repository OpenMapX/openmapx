import type { Metadata } from "next";
import { ExtensionStorePage } from "@/components/admin/extensions/ExtensionStorePage";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("extensions");
}

export default function AdminExtensionsPage() {
  return <ExtensionStorePage />;
}
