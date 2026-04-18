"use client";

import { useQuery } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";

export function useComposePreview() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  return useQuery({
    queryKey: ["admin", "compose-preview"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/compose/preview`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    },
  });
}
