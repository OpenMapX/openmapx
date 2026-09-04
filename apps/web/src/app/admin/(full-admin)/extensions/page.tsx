import type { Metadata } from "next";
import { ExtensionStorePage } from "@/components/admin/extensions/ExtensionStorePage";

export const metadata: Metadata = { title: "Extensions — Admin — OpenMapX" };

export default function AdminExtensionsPage() {
  return <ExtensionStorePage />;
}
