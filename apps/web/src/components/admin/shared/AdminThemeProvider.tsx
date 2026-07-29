"use client";

import { alpha, createTheme, type Theme, ThemeProvider, useTheme } from "@mui/material/styles";
import { type ReactNode, useMemo } from "react";

/**
 * Admin-only Material theme. The public map deliberately has a different
 * density and surface model, so dashboard defaults live in this nested theme
 * instead of being repeated as `sx` props across every admin page.
 */
export function AdminThemeProvider({ children }: { children: ReactNode }) {
  const parentTheme = useTheme();
  const adminTheme = useMemo(
    () =>
      createTheme(parentTheme, {
        shape: { borderRadius: 10 },
        typography: {
          h5: { fontSize: "1.375rem", lineHeight: 1.35, fontWeight: 700 },
          h6: { fontSize: "1.125rem", lineHeight: 1.4, fontWeight: 700 },
          subtitle1: { fontSize: "0.9375rem", lineHeight: 1.45, fontWeight: 650 },
          body2: { fontSize: "0.8125rem", lineHeight: 1.5 },
          caption: { fontSize: "0.75rem", lineHeight: 1.45 },
        },
        components: {
          MuiAlert: {
            defaultProps: { variant: "outlined" },
            styleOverrides: { root: { borderRadius: 10 } },
          },
          MuiButton: {
            defaultProps: { size: "small", disableElevation: true },
            styleOverrides: {
              root: { minHeight: 34, borderRadius: 8, paddingInline: 12 },
            },
          },
          MuiCard: {
            defaultProps: { elevation: 0 },
            styleOverrides: {
              root: ({ theme }: { theme: Theme }) => ({
                borderColor: alpha(theme.palette.text.primary, 0.12),
                borderRadius: 12,
              }),
            },
          },
          MuiCardContent: {
            styleOverrides: {
              root: { padding: 16, "&:last-child": { paddingBottom: 16 } },
            },
          },
          MuiChip: {
            defaultProps: { size: "small" },
            styleOverrides: {
              root: { height: 24, borderRadius: 7, fontWeight: 550 },
              labelSmall: { paddingInline: 8 },
            },
          },
          MuiDialog: {
            styleOverrides: { paper: { borderRadius: 16 } },
          },
          MuiDialogActions: {
            styleOverrides: { root: { padding: "8px 20px 16px" } },
          },
          MuiDialogContent: {
            styleOverrides: { root: { padding: "12px 20px" } },
          },
          MuiDialogTitle: {
            styleOverrides: { root: { padding: "18px 20px 8px", fontSize: "1.125rem" } },
          },
          MuiFormControl: { defaultProps: { size: "small" } },
          MuiIconButton: {
            defaultProps: { size: "small" },
            styleOverrides: { root: { borderRadius: 8 } },
          },
          MuiPaper: {
            defaultProps: { elevation: 0 },
            styleOverrides: {
              outlined: ({ theme }: { theme: Theme }) => ({
                borderColor: alpha(theme.palette.text.primary, 0.12),
                borderRadius: 12,
              }),
            },
          },
          MuiTab: {
            defaultProps: { disableRipple: true },
            styleOverrides: {
              root: {
                minHeight: 44,
                minWidth: 0,
                padding: "10px 14px",
                textTransform: "none",
                fontSize: "0.8125rem",
                fontWeight: 600,
              },
            },
          },
          MuiTable: { defaultProps: { size: "small", stickyHeader: false } },
          MuiTableCell: {
            styleOverrides: {
              root: ({ theme }: { theme: Theme }) => ({
                padding: "9px 12px",
                borderColor: alpha(theme.palette.text.primary, 0.09),
                fontSize: "0.8125rem",
              }),
              head: ({ theme }: { theme: Theme }) => ({
                backgroundColor: alpha(theme.palette.text.primary, 0.035),
                color: theme.palette.text.secondary,
                fontSize: "0.75rem",
                fontWeight: 700,
                letterSpacing: "0.015em",
                whiteSpace: "nowrap",
              }),
            },
          },
          MuiTablePagination: {
            styleOverrides: {
              root: ({ theme }: { theme: Theme }) => ({
                borderTop: `1px solid ${alpha(theme.palette.text.primary, 0.09)}`,
              }),
              toolbar: { minHeight: "50px !important", paddingInline: 12 },
              selectLabel: { margin: 0 },
              displayedRows: { margin: 0 },
            },
          },
          MuiTableRow: {
            styleOverrides: {
              root: ({ theme }: { theme: Theme }) => ({
                "&.MuiTableRow-hover:hover": {
                  backgroundColor: alpha(theme.palette.primary.main, 0.035),
                },
                "&:last-child td": { borderBottom: 0 },
              }),
            },
          },
          MuiTabs: {
            styleOverrides: {
              root: ({ theme }: { theme: Theme }) => ({
                minHeight: 44,
                borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.1)}`,
              }),
              indicator: { height: 3, borderRadius: "3px 3px 0 0" },
            },
          },
          MuiTextField: { defaultProps: { size: "small" } },
          MuiToggleButton: {
            defaultProps: { size: "small" },
            styleOverrides: {
              root: { minHeight: 34, padding: "5px 11px", textTransform: "none" },
            },
          },
          MuiToolbar: { styleOverrides: { dense: { minHeight: 48 } } },
          MuiTooltip: { defaultProps: { arrow: true, enterDelay: 450 } },
        },
      }),
    [parentTheme],
  );

  return <ThemeProvider theme={adminTheme}>{children}</ThemeProvider>;
}
