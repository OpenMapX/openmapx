"use client";

import Skeleton from "@mui/material/Skeleton";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";

interface TableSkeletonProps {
  rows?: number;
  columns: number;
}

export function TableSkeleton({ rows = 5, columns }: TableSkeletonProps) {
  return (
    <TableBody>
      {Array.from({ length: rows }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows have no data identity
        <TableRow key={`row-${i}`}>
          {Array.from({ length: columns }).map((_, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cells have no data identity
            <TableCell key={`col-${j}`}>
              <Skeleton variant="text" height={20} sx={{ maxWidth: j === 0 ? 40 : undefined }} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}
