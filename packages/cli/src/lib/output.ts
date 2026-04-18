import kleur from "kleur";

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(kleur.green(`✓ ${msg}`)),
  warn: (msg: string) => console.error(kleur.yellow(`⚠ ${msg}`)),
  err: (msg: string) => console.error(kleur.red(`✗ ${msg}`)),
  dim: (msg: string) => console.log(kleur.dim(msg)),
};

export interface TableColumn {
  key: string;
  header: string;
  width?: number;
}

export function table(columns: TableColumn[], rows: Array<Record<string, string>>): string {
  const widths = columns.map(
    (c) => c.width ?? Math.max(c.header.length, ...rows.map((r) => (r[c.key] ?? "").length)),
  );
  const hdr = columns.map((c, i) => c.header.padEnd(widths[i] ?? 0)).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  const body = rows
    .map((r) => columns.map((c, i) => (r[c.key] ?? "").padEnd(widths[i] ?? 0)).join("  "))
    .join("\n");
  return `${kleur.bold(hdr)}\n${kleur.dim(sep)}\n${body}`;
}
