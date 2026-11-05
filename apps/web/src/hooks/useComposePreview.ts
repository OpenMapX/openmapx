"use client";

import { useQuery } from "@tanstack/react-query";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";

export function useComposePreview() {
  const { client, apiUrl } = useActivityClient();
  return useQuery(serviceAdminQueries(client, apiUrl).composeDocument());
}
