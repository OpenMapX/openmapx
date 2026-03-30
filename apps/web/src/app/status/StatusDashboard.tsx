"use client";

import { useCallback, useEffect, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

interface ServiceStatus {
  id: string;
  name: string;
  category: string;
  url: string;
  status: "up" | "down" | "unconfigured";
  responseTime?: number;
  error?: string;
}

interface StatusResponse {
  timestamp: string;
  services: ServiceStatus[];
}

const CATEGORY_ORDER = [
  "Infrastructure",
  "Geocoding",
  "Routing",
  "Transit",
  "Map Tiles",
  "Imagery",
  "Traffic",
  "Data Overlays",
  "Parking",
  "Shared Mobility",
  "Fuel Prices",
  "Enrichment",
  "External",
];

const STATUS_COLORS: Record<string, string> = {
  up: "bg-green-500",
  down: "bg-red-500",
  unconfigured: "bg-gray-300",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  up: "text-green-600",
  down: "text-red-600",
  unconfigured: "text-gray-400",
};

const STATUS_LABELS: Record<string, string> = {
  up: "Operational",
  down: "Down",
  unconfigured: "Not configured",
};

export default function StatusDashboard() {
  const { apiUrl } = useEnv();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchStatus]);

  const grouped = data
    ? data.services.reduce<Record<string, ServiceStatus[]>>((acc, s) => {
        if (!acc[s.category]) acc[s.category] = [];
        acc[s.category].push(s);
        return acc;
      }, {})
    : {};

  const categories = CATEGORY_ORDER.filter((c) => grouped[c]?.length);
  for (const c of Object.keys(grouped)) {
    if (!categories.includes(c)) categories.push(c);
  }

  const upCount = data?.services.filter((s) => s.status === "up").length ?? 0;
  const downCount = data?.services.filter((s) => s.status === "down").length ?? 0;
  const unconfiguredCount = data?.services.filter((s) => s.status === "unconfigured").length ?? 0;

  return (
    <div className="h-dvh overflow-auto bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold text-gray-900">System Status</h1>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              Auto-refresh
            </label>
            <button
              type="button"
              onClick={fetchStatus}
              disabled={loading}
              className="px-3 py-1.5 text-sm font-medium bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              {loading ? "Checking\u2026" : "Refresh"}
            </button>
          </div>
        </div>

        {data && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm mb-6">
            <span className="text-green-600 font-medium">{upCount} operational</span>
            {downCount > 0 && <span className="text-red-600 font-medium">{downCount} down</span>}
            {unconfiguredCount > 0 && (
              <span className="text-gray-400">{unconfiguredCount} not configured</span>
            )}
            <span className="text-gray-400 ml-auto">
              {new Date(data.timestamp).toLocaleString()}
            </span>
          </div>
        )}

        {error && !data && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-6">
            Failed to load status: {error}
          </div>
        )}

        {loading && !data && (
          <div className="space-y-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="h-4 w-32 bg-gray-200 rounded mb-2" />
                <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                  <div className="h-4 bg-gray-100 rounded w-full" />
                  <div className="h-4 bg-gray-100 rounded w-3/4" />
                </div>
              </div>
            ))}
          </div>
        )}

        {categories.map((category) => {
          const services = grouped[category];
          if (!services?.length) return null;
          return (
            <div key={category} className="mb-6">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                {category}
              </h2>
              <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 shadow-sm">
                {services.map((s) => (
                  <div key={s.id} className="px-4 py-3 flex items-start gap-3">
                    <span
                      className={`mt-1.5 shrink-0 w-2.5 h-2.5 rounded-full ${STATUS_COLORS[s.status] ?? "bg-gray-300"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-medium text-sm text-gray-900">{s.name}</span>
                        <span
                          className={`text-xs font-medium ${STATUS_TEXT_COLORS[s.status] ?? "text-gray-400"}`}
                        >
                          {STATUS_LABELS[s.status] ?? s.status}
                        </span>
                        {s.responseTime != null && (
                          <span className="text-xs text-gray-400">{s.responseTime}ms</span>
                        )}
                      </div>
                      <div
                        className="text-xs text-gray-500 font-mono truncate mt-0.5"
                        title={s.url}
                      >
                        {s.url}
                      </div>
                      {s.error && <div className="text-xs text-red-500 mt-0.5">{s.error}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        <div className="text-center text-xs text-gray-400 mt-8 pb-4">OpenMapX Status Dashboard</div>
      </div>
    </div>
  );
}
