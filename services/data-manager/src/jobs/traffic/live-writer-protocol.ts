import type { WriteLiveTrafficDeps, WriteLiveTrafficResult } from "./write-live.js";

export interface LiveWriterRequest {
  id: number;
  deps: Omit<WriteLiveTrafficDeps, "logger">;
}
export type LiveWriterResponse =
  | { id: number; type: "result"; result: WriteLiveTrafficResult }
  | { id: number; type: "error"; error: { name: string; message: string; code?: string } }
  | { id: number; type: "warning"; message: string; extra?: Record<string, unknown> };
