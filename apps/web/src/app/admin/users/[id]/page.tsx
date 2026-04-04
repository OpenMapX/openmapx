import type { Metadata } from "next";
import { UserDetail } from "@/components/admin/users/UserDetail";

export const metadata: Metadata = { title: "User Detail — Admin — OpenMapX" };

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetail userId={id} />;
}
