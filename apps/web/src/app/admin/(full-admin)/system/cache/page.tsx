import type { Metadata } from "next";
import { CacheManager } from "@/components/admin/cache/CacheManager";
export const metadata: Metadata = { title: "Cache — Admin — OpenMapX" };
export default function Page() {
  return <CacheManager />;
}
