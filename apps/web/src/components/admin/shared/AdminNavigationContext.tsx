"use client";
import { createContext, useContext } from "react";
import type { AdminNavigationAccess } from "@/lib/admin/adminNavigation";
/** Server-resolved presentation availability; API guards still authorize every operation. */
export const AdminNavigationContext = createContext<AdminNavigationAccess>({
  role: "admin",
  selfHosted: null,
});
export const useAdminNavigationAccess = () => useContext(AdminNavigationContext);
