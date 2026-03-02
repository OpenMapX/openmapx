/**
 * Thin fetch wrapper for the OpenMapX API gateway (`apps/api`).
 * All frontend data fetching goes through this client — never directly
 * to Pelias / OSRM / Valhalla.
 */

const DEFAULT_BASE_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000")
    : "http://localhost:3000";

export class ApiClient {
  constructor(private readonly baseUrl: string = DEFAULT_BASE_URL) {}

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }
}

export const apiClient = new ApiClient();
