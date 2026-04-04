import type { Metadata } from "next";
import { StorePage } from "@/components/admin/store/StorePage";

export const metadata: Metadata = { title: "Store — Admin — OpenMapX" };

export default function AdminStorePage() {
  return <StorePage />;
}
