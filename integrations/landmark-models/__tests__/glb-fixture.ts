/**
 * Writes a minimal binary glTF for tests: one box-shaped triangle soup with
 * positions, normals, a named material and an optional `_FLOODLIGHT` attribute.
 */
export function makeGlb(
  options: { materialName?: string; floodlight?: boolean; size?: number } = {},
): ArrayBuffer {
  const size = options.size ?? 10;
  const positions = new Float32Array([0, 0, 0, size, 0, 0, size, size, 0, 0, 0, size]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const flood = new Float32Array([0, 1, 1, 0]);
  const chunks = [
    positions,
    normals,
    new Uint8Array(indices.buffer),
    ...(options.floodlight ? [flood] : []),
  ];
  const views: { byteOffset: number; byteLength: number }[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    views.push({ byteOffset: offset, byteLength: chunk.byteLength });
    offset += Math.ceil(chunk.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(offset);
  chunks.forEach((chunk, i) => {
    bin.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), views[i]?.byteOffset);
  });
  const attributes: Record<string, number> = { POSITION: 0, NORMAL: 1 };
  if (options.floodlight) attributes._FLOODLIGHT = 3;
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: 2, material: 0 }] }],
    materials: [
      {
        name: options.materialName ?? "stone",
        pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] },
      },
    ],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: views.map((view) => ({ buffer: 0, ...view })),
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: "VEC3",
        min: [0, 0, 0],
        max: [size, size, size],
      },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
      ...(options.floodlight
        ? [{ bufferView: 3, componentType: 5126, count: 4, type: "SCALAR" }]
        : []),
    ],
  };
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4 !== 0) jsonText += " ";
  const jsonBytes = new TextEncoder().encode(jsonText);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonBytes.byteLength).set(jsonBytes);
  const binStart = 20 + jsonBytes.byteLength;
  view.setUint32(binStart, bin.byteLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  new Uint8Array(out, binStart + 8, bin.byteLength).set(bin);
  return out;
}
