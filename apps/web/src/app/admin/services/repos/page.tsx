import type { Metadata } from "next";
import { ServiceRepoList } from "@/components/admin/services/ServiceRepoList";

export const metadata: Metadata = { title: "Service Repositories — Admin — OpenMapX" };

export default function ServiceReposPage() {
  return <ServiceRepoList />;
}
