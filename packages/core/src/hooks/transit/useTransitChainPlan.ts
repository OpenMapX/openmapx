import { useQuery } from "@tanstack/react-query";
import { postTransitChainPlan, type TransitChainPlanRequest } from "../../api/transit";
import { stableRequestKey } from "../useScheduledDirections";

/**
 * The single source of truth for the chained-transit query key, built on the
 * same stable stringifier the scheduled-directions key uses so two callers with
 * differently-ordered request objects still share one cache entry.
 */
export function transitChainQueryKey(request: TransitChainPlanRequest): string[] {
  return ["transit-chain", stableRequestKey(request)];
}

/** Pass `null` to disable the query (fewer than three stops, or incomplete). */
export function useTransitChainPlan(request: TransitChainPlanRequest | null) {
  return useQuery({
    queryKey: request ? transitChainQueryKey(request) : ["transit-chain", "disabled"],
    queryFn: () => postTransitChainPlan(request as TransitChainPlanRequest),
    enabled: request !== null,
    staleTime: 30_000,
    retry: false,
  });
}
