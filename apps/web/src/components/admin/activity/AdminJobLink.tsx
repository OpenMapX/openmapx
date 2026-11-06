"use client";
import Button from "@mui/material/Button";
import type { AdminActivityJobSource } from "@openmapx/core/api-contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
export function AdminJobLink({
  id,
  source,
  returnTo,
  children = "View job",
}: {
  id: string;
  source: AdminActivityJobSource;
  returnTo?: string;
  children?: ReactNode;
}) {
  return (
    <Button
      component={Link}
      href={adminJobHref({ id, source, returnTo })}
      size="small"
      sx={{ alignSelf: "flex-start" }}
    >
      {children}
    </Button>
  );
}
