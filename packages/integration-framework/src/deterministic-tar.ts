import { gzipSync } from "node:zlib";

// A minimal, deterministic ustar writer.
//
// Platform `tar` dialects disagree about the flags that make output
// reproducible (`--mtime`, `--owner`, `--group` are GNU-only; bsdtar rejects
// them), so the artifact packager builds the archive itself. Every header field
// that would otherwise vary by machine — owner, group, mode, mtime, and entry
// order — is fixed here, which is what makes two builds of the same source
// produce byte-identical bytes.

const BLOCK = 512;
const FIXED_MODE = 0o644;
const FIXED_MTIME = 0;

export interface TarEntry {
  /** Path inside the archive, always POSIX-separated. */
  path: string;
  contents: Buffer;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function writeField(header: Buffer, offset: number, value: string, length: number): void {
  header.write(value.slice(0, length), offset, length, "utf8");
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  const cut = path.lastIndexOf("/", 155);
  const prefix = cut > 0 ? path.slice(0, cut) : "";
  const name = cut > 0 ? path.slice(cut + 1) : path;
  if (Buffer.byteLength(name, "utf8") > 100 || Buffer.byteLength(prefix, "utf8") > 155) {
    throw new Error(`Archive path is too long for the ustar format: ${path}`);
  }
  return { name, prefix };
}

function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(BLOCK);
  const { name, prefix } = splitUstarPath(entry.path);
  writeField(block, 0, name, 100);
  writeField(block, 100, octal(FIXED_MODE, 8), 8);
  writeField(block, 108, octal(0, 8), 8); // uid
  writeField(block, 116, octal(0, 8), 8); // gid
  writeField(block, 124, octal(entry.contents.length, 12), 12);
  writeField(block, 136, octal(FIXED_MTIME, 12), 12);
  block.write("        ", 148, 8, "utf8"); // checksum placeholder
  block.write("0", 156, 1, "utf8"); // regular file
  writeField(block, 257, "ustar\0", 6);
  writeField(block, 263, "00", 2);
  writeField(block, 265, "root", 32); // uname
  writeField(block, 297, "root", 32); // gname
  writeField(block, 345, prefix, 155);

  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeField(block, 148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
  return block;
}

function pad(length: number): Buffer {
  const remainder = length % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/**
 * Build a gzip-compressed tar from `entries`, sorted by path. Callers pass the
 * exact allowlisted file set; nothing is discovered from the filesystem here.
 */
export function createDeterministicTarGz(entries: readonly TarEntry[]): Buffer {
  // Code-unit ordering, not `localeCompare`: collation varies with the host
  // ICU locale and would make the archive non-reproducible across machines.
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : 1));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(header(entry), entry.contents, pad(entry.contents.length));
  }
  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(BLOCK * 2));
  // Node writes a zero MTIME into the gzip header (there is no source file to
  // stamp), so the compressed bytes are reproducible too.
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
