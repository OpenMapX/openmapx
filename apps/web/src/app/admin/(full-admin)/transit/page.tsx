import type { Metadata } from "next";
import { TransitPipelinePage } from "./TransitPipelinePage";

export const metadata: Metadata = { title: "Transit pipeline — Admin — OpenMapX" };

export default function AdminTransitPage() {
  return <TransitPipelinePage />;
}
