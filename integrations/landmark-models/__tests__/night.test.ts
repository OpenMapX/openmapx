import { BufferAttribute, BufferGeometry, Color, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { nightColor, nightVertexColors } from "../web/night";

const round = (values: number[]) => values.map((v) => Math.round(v * 1000) / 1000);
const linear = (hex: string) =>
  [1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);

describe("nightColor", () => {
  it("windows glow warm", () => {
    expect(nightColor([0.5, 0.5, 0.5], "window-a", 0, 1)).toEqual([1, 0.72, 0.4]);
    expect(nightColor([0.5, 0.5, 0.5], "entrance", 0, 1)).toEqual([1, 0.72, 0.4]);
  });

  it("lamps use the lamp colour", () => {
    expect(round(nightColor([0.2, 0.2, 0.2], "lamp-post", 0, 1))).toEqual(round(linear("#ffe7c4")));
  });

  it("unlit surfaces are dim blue-tinted", () => {
    expect(round(nightColor([1, 1, 1], "stone", 0, 1))).toEqual([0.172, 0.176, 0.19]);
  });

  it("floodlight 1 lerps 90% of the way to the flood colour", () => {
    const flood = linear("#ffeacf");
    const ambient = [0.012, 0.016, 0.03];
    const expected = [0, 1, 2].map((i) => {
      const dim = 0.16 + (ambient[i] as number);
      return dim + ((flood[i] as number) - dim) * 0.9;
    });
    expect(round(nightColor([1, 1, 1], "stone", 1, 1))).toEqual(round(expected));
  });

  it("neon keeps its own brightened colour and emissive adds light", () => {
    expect(round(nightColor([0.5, 0.1, 0.2], "neon-sign", 0, 1))).toEqual([0.69, 0.17, 0.3]);
    expect(round(nightColor([1, 1, 1], "stone", 0, 1, [0.1, 0, 0]))).toEqual([0.272, 0.176, 0.19]);
  });
});

describe("nightVertexColors", () => {
  it("colours each vertex from the material, normal and floodlight attribute", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0]), 3));
    geometry.setAttribute("_floodlight", new BufferAttribute(new Float32Array([0, 1]), 1));
    const material = new MeshStandardMaterial({ color: new Color(1, 1, 1) });
    material.name = "stone";
    const colors = nightVertexColors(geometry, material);
    expect(colors).toHaveLength(8);
    // Brighter where floodlit.
    expect(colors[4] as number).toBeGreaterThan(colors[0] as number);
    expect(colors[3]).toBe(1);
  });
});
