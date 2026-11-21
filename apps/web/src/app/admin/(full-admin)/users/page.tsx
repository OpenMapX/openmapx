import type { Metadata } from "next";
import { UserList } from "@/components/admin/users/UserList";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("users");
}

export default function AdminUsersPage() {
  return <UserList />;
}
