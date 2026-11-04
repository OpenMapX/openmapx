"use client";
import { usePathname } from "next/navigation";
export function PhoneOnly({ children }: { children: React.ReactNode }) {
  return usePathname() === "/car" ? null : children;
}
