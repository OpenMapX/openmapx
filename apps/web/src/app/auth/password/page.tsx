import type { Metadata } from "next";
import { PasswordSetupForm } from "@/components/auth/PasswordSetupForm";
export const metadata: Metadata = {
  title: "Choose your password — OpenMapX",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default function PasswordSetupPage() {
  return <PasswordSetupForm />;
}
