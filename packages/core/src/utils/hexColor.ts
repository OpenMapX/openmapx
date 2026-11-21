/** Mix two `#rrggbb` colours channel by channel; `t` 0 gives `from`, 1 gives `to`. */
export function lerpHex(from: string, to: string, t: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  const mix = (at: number) =>
    Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}
