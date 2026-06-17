import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

export function TableEmptyState({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} align="center" sx={{ py: 4 }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {message}
        </Typography>
      </TableCell>
    </TableRow>
  );
}
