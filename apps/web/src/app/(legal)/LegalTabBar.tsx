"use client";

import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import NextLink from "next/link";
import { usePathname } from "next/navigation";

interface LegalTabBarProps {
  pages: { label: string; href: string }[];
}

export function LegalTabBar({ pages }: LegalTabBarProps) {
  const pathname = usePathname();

  const currentTab = Math.max(
    0,
    pages.findIndex((p) => pathname.startsWith(p.href)),
  );

  return (
    <Tabs
      value={currentTab}
      sx={{
        px: 3,
        minHeight: 42,
        "& .MuiTab-root": {
          minHeight: 42,
          textTransform: "none",
          fontWeight: 500,
          fontSize: 14,
          px: 2,
        },
      }}
    >
      {pages.map((p) => (
        <Tab key={p.href} label={p.label} component={NextLink} href={p.href} />
      ))}
    </Tabs>
  );
}
