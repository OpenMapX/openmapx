import type { Metadata } from "next";
import { ServiceDetail } from "@/components/admin/services/ServiceDetail";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return adminPageMetadata("serviceDetail", { id });
}

export default async function AdminServiceDetailPage({ params }: Props) {
  const { id } = await params;
  return <ServiceDetail id={id} />;
}
