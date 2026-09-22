/** Synthetic USTAR layout, independent of the writer's index/offset helpers. */
export function trafficFixture(tileCount = 1, edgesPerTile = 6): Buffer {
  const padded = (n: number) => Math.ceil(n / 512) * 512;
  const header = (name: string, size: number) => {
    const data = Buffer.alloc(512);
    data.write(name);
    for (const [offset, width, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, size],
      [136, 12, 0],
    ]) {
      data.write(value.toString(8).padStart(width - 1, "0"), offset, "ascii");
    }
    data.fill(32, 148, 156);
    data[156] = 48;
    data.write("ustar", 257);
    data.write("00", 263);
    data.write(
      data
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0"),
      148,
    );
    data[154] = 0;
    data[155] = 32;
    return data;
  };
  const size = 32 + edgesPerTile * 8;
  const indexSize = tileCount * 16;
  const firstHeader = 512 + padded(indexSize);
  const tar = Buffer.alloc(firstHeader + tileCount * (512 + padded(size)) + 1024);
  header("index.bin", indexSize).copy(tar);
  for (let tile = 0; tile < tileCount; tile++) {
    const member = firstHeader + tile * (512 + padded(size));
    const data = member + 512;
    const graphId = (BigInt(tile) << 3n) | 2n;
    tar.writeBigUInt64LE(BigInt(data), 512 + tile * 16);
    tar.writeUInt32LE(Number(graphId), 512 + tile * 16 + 8);
    tar.writeUInt32LE(size, 512 + tile * 16 + 12);
    header(`2/${tile}.gph`, size).copy(tar, member);
    tar.writeBigUInt64LE(graphId, data);
    tar.writeUInt32LE(edgesPerTile, data + 16);
    tar.writeUInt32LE(3, data + 20);
  }
  return tar;
}
