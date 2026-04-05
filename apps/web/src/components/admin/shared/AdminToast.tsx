"use client";

import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import { createContext, useCallback, useContext, useState } from "react";

type ToastSeverity = "success" | "error" | "info" | "warning";

interface ToastState {
  open: boolean;
  message: string;
  severity: ToastSeverity;
}

interface AdminToastContextValue {
  showToast: (message: string, severity?: ToastSeverity) => void;
}

const AdminToastContext = createContext<AdminToastContextValue | null>(null);

export function AdminToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState>({ open: false, message: "", severity: "success" });

  const showToast = useCallback((message: string, severity: ToastSeverity = "success") => {
    setToast({ open: true, message, severity });
  }, []);

  return (
    <AdminToastContext.Provider value={{ showToast }}>
      {children}
      <Snackbar
        open={toast.open}
        autoHideDuration={4000}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={toast.severity}
          onClose={() => setToast((t) => ({ ...t, open: false }))}
          variant="filled"
          sx={{ width: "100%" }}
        >
          {toast.message}
        </Alert>
      </Snackbar>
    </AdminToastContext.Provider>
  );
}

export function useAdminToast(): AdminToastContextValue["showToast"] {
  const ctx = useContext(AdminToastContext);
  if (!ctx) return (msg: string) => console.warn("AdminToastProvider not found, toast:", msg);
  return ctx.showToast;
}
