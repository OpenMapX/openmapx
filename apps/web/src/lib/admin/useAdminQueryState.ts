"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { adminQueryHref } from "./adminNavigationState";

export function useAdminQueryState() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return {
    params,
    update(changes: Record<string, string | null>, mode: "push" | "replace" = "push") {
      router[mode](adminQueryHref(pathname, new URLSearchParams(params.toString()), changes), {
        scroll: false,
      });
    },
  };
}
export function useAdminTab(tabs: readonly string[]) {
  const { params, update } = useAdminQueryState();
  const index = tabs.indexOf(params.get("tab") ?? "");
  return [Math.max(0, index), (value: number) => update({ tab: tabs[value] ?? null })] as const;
}
