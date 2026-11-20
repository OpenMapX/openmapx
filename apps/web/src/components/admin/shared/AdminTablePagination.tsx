"use client";

import TablePagination from "@mui/material/TablePagination";
import { useTranslations } from "next-intl";
import type { ChangeEvent } from "react";

export const DEFAULT_ROWS_PER_PAGE_OPTIONS = [25, 50, 100];

export interface AdminTablePaginationProps {
  count: number;
  page: number;
  rowsPerPage: number;
  onPageChange: (event: unknown, page: number) => void;
  onRowsPerPageChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  rowsPerPageOptions?: number[];
  /**
   * Hide the control entirely when everything fits on a single page at the
   * smallest page size (default true). Keeps small/detail tables uncluttered
   * while large tables paginate — so every admin table can use this uniformly.
   */
  hideSinglePage?: boolean;
}

/**
 * Standard pagination footer for admin tables. Presentational — drive it with
 * `useClientPagination().paginationProps` (client-side) or server-side state.
 */
export function AdminTablePagination({
  count,
  page,
  rowsPerPage,
  onPageChange,
  onRowsPerPageChange,
  rowsPerPageOptions = DEFAULT_ROWS_PER_PAGE_OPTIONS,
  hideSinglePage = true,
}: AdminTablePaginationProps) {
  const t = useTranslations("adminShared");
  if (count === 0) return null;
  if (hideSinglePage && count <= (rowsPerPageOptions[0] ?? 25)) return null;
  return (
    <TablePagination
      component="div"
      count={count}
      page={page}
      rowsPerPage={rowsPerPage}
      rowsPerPageOptions={rowsPerPageOptions}
      onPageChange={onPageChange}
      onRowsPerPageChange={onRowsPerPageChange}
      labelRowsPerPage={t("rowsPerPage")}
      labelDisplayedRows={({ from, to, count: total }) =>
        t("displayedRows", { from, to, total: total === -1 ? to : total })
      }
      getItemAriaLabel={(type) => t("paginationPage", { type })}
    />
  );
}
