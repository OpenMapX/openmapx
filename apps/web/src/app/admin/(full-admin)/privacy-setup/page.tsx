import type { Metadata } from "next";
import { adminPageMetadata } from "@/lib/admin/adminPageMetadata";
import { PrivacySetupPage } from "./PrivacySetupPage";

export function generateMetadata(): Promise<Metadata> {
  return adminPageMetadata("privacySetup");
}

export default function PrivacySetupRoute() {
  return <PrivacySetupPage />;
}
