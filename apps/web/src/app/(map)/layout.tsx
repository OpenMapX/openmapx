import { OfflineNotice } from "@/components/OfflineNotice";

export default function MapLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-full h-full overflow-hidden">
      {children}
      <OfflineNotice />
    </div>
  );
}
