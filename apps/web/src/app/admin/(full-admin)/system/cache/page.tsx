import type { Metadata } from "next";
import { CacheManager } from "@/components/admin/cache/CacheManager";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("cache");
}
export default function Page() {
  return <CacheManager />;
}
