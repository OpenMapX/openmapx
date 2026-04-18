import type { Metadata } from "next";
import { ServiceDetail } from "@/components/admin/services/ServiceDetail";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `${id} — Services — Admin — OpenMapX` };
}

export default async function AdminServiceDetailPage({ params }: Props) {
  const { id } = await params;
  return <ServiceDetail id={id} />;
}
