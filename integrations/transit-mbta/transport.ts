import type { ZodType } from "zod";
import type { MbtaClient } from "./client";
import { MbtaError } from "./errors";
import { Alerts, Facilities, Predictions, Stop, Stops, Vehicles } from "./generated/models";
export interface MbtaRequestOptions {
  client?: MbtaClient;
  signal?: AbortSignal;
  schema?: ZodType;
  method?: string;
}
const bindings = new Map<string, ZodType>([
  ["/stops", Stops],
  ["/predictions", Predictions],
  ["/vehicles", Vehicles],
  ["/alerts", Alerts],
  ["/facilities", Facilities],
]);
export async function mbtaRequest<T>(url: string, options?: MbtaRequestOptions): Promise<T> {
  const path = url.split("?", 1)[0];
  const schema = bindings.get(path) ?? (/^\/stops\/[^/]+$/.test(path) ? Stop : undefined);
  if (!options?.client || options.method !== "GET" || !schema || options.schema !== schema)
    throw new MbtaError("input");
  // Generated functions bind their exact success type and validator together.
  return options.client.request(url, schema, options.signal) as Promise<T>;
}
