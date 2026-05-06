export function parseDelimited(text: string, delimiter = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

export function rowsToObjects(rows: string[][], headerIndex: number): Record<string, string>[] {
  const header = rows[headerIndex];
  if (!header) return [];
  return rows.slice(headerIndex + 1).map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((key, index) => {
      if (key) obj[key] = row[index] ?? "";
    });
    return obj;
  });
}
