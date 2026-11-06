import { notFound } from "next/navigation";
import { SettingsWorkspace } from "@/components/admin/settings/SettingsWorkspace";
import { SETTINGS_TOPICS } from "@/lib/admin/adminNavigation";
export default async function Page({ params }: { params: Promise<{ topic: string }> }) {
  const { topic } = await params;
  const valid = SETTINGS_TOPICS.find((value) => value === topic);
  if (!valid) notFound();
  return <SettingsWorkspace topic={valid} />;
}
