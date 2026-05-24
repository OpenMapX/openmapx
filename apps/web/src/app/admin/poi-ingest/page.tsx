import type { Metadata } from "next";
import { PoiIngestPage } from "./PoiIngestPage";

export const metadata: Metadata = { title: "POI ingest — Admin — OpenMapX" };

export default function AdminPoiIngestPage() {
  return <PoiIngestPage />;
}
