import type { Metadata } from "next";
import { PrivacySetupPage } from "./PrivacySetupPage";

export const metadata: Metadata = { title: "Privacy setup — Admin — OpenMapX" };

export default function PrivacySetupRoute() {
  return <PrivacySetupPage />;
}
