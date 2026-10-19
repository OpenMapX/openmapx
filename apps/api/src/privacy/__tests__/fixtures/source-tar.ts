/** Independent USTAR fixtures shared by the two source-protocol suites. */
export function checksumTarHeader(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

export function tarMember(path: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  checksumTarHeader(header);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

export function tar(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([
    ...entries.map(([path, content]) => tarMember(path, content)),
    Buffer.alloc(1024),
  ]);
}

export function changeTarHeader(input: Buffer, mutate: (header: Buffer) => void): Buffer {
  const result = Buffer.from(input);
  const header = result.subarray(0, 512);
  mutate(header);
  checksumTarHeader(header);
  return result;
}

/** Each case crosses a raw framing boundary before protocol manifests matter. */
export function invalidTarCases(path: string): Array<[string, Buffer, string]> {
  const input = tar([[path, Buffer.from("x")]]);
  const padding = Buffer.from(input);
  padding[513] = 1;
  const checksum = Buffer.from(input);
  checksum[100] ^= 1;
  const type = (value: number) =>
    changeTarHeader(input, (header) => {
      header[156] = value;
    });
  return [
    ["missing magic", changeTarHeader(input, (h) => h.fill(0, 257, 263)), "invalid_header"],
    [
      "high-bit magic",
      changeTarHeader(input, (h) => {
        h[257] |= 128;
      }),
      "invalid_header",
    ],
    ["unsupported version", changeTarHeader(input, (h) => h.write("01", 263)), "invalid_header"],
    ["bad checksum", checksum, "checksum"],
    [
      "hidden numeric suffix",
      changeTarHeader(input, (h) => {
        h.fill(0, 124, 136);
        h.write("1\0q", 124);
      }),
      "invalid_header",
    ],
    [
      "malformed octal",
      changeTarHeader(input, (h) => h.write("0000000001q\0", 124)),
      "invalid_header",
    ],
    [
      "binary size",
      changeTarHeader(input, (h) => {
        h.fill(0, 124, 136);
        h[124] = 128;
        h[135] = 1;
      }),
      "invalid_header",
    ],
    ["directory", type(53), "unsupported_type"],
    ["symbolic link", type(50), "unsupported_type"],
    ["hard link", type(49), "unsupported_type"],
    ["unknown type", type(63), "unsupported_type"],
    ["PAX extension", type(120), "unsupported_type"],
    ["GNU extension", type(76), "unsupported_type"],
    ["nonzero padding", padding, "invalid_header"],
    ["truncated header", input.subarray(0, 511), "truncated"],
    ["truncated body", input.subarray(0, 512), "truncated"],
    ["truncated padding", input.subarray(0, 514), "truncated"],
  ];
}

export function invalidTarEndings(valid: Buffer): Array<[string, Buffer, string]> {
  return [
    ["missing end markers", valid.subarray(0, -1024), "truncated"],
    ["one end marker", valid.subarray(0, -512), "truncated"],
    ["partial second end marker", valid.subarray(0, -1), "truncated"],
    ["nonzero trailer", Buffer.concat([valid, Buffer.from("x")]), "trailing_data"],
    ["concatenated archive", Buffer.concat([valid, valid]), "trailing_data"],
  ];
}
