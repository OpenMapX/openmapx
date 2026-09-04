import type { Metadata } from "next";
import { UserList } from "@/components/admin/users/UserList";

export const metadata: Metadata = { title: "Users — Admin — OpenMapX" };

export default function AdminUsersPage() {
  return <UserList />;
}
