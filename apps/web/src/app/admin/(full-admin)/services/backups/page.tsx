import type { Metadata } from "next";
import { BackupsPage } from "@/components/admin/services/BackupsPage";

export const metadata: Metadata = { title: "Backups — Admin — OpenMapX" };

export default function AdminBackupsPage() {
  return <BackupsPage />;
}
