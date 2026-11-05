export function downloadMigrationJson(value: unknown, filename: string) {
  const json = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(json).length > 1048576) throw Error("Transfer exceeds1MiB");
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" })),
    a = document.createElement("a");
  try {
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
