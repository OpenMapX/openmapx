import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon";

/**
 * How far the street grid leans from upright on screen, in degrees clockwise.
 * A grid looks the same every 90°, so the answer is folded into [−45, 45).
 */
export function gridScreenTilt(axis: number, mapBearing: number): number {
  return ((((axis - mapBearing) % 90) + 135) % 90) - 45;
}

// Streets wide enough to stay open between tilted blocks at 1x.
const BLOCK = 4;
const HALF_STREET = 1.3;
const NEAR = 12 - HALF_STREET - BLOCK;
const FAR = 12 + HALF_STREET;

/**
 * Four city blocks leaning as the streets on screen do, inside upright frame
 * corners: tapping straightens the blocks into the frame. The lean follows the
 * live map, so the icon stands square once the map is aligned.
 */
export function AlignToStreetsIcon({ tilt, ...props }: SvgIconProps & { tilt: number }) {
  return (
    <SvgIcon {...props}>
      <path
        d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <g transform={`rotate(${tilt} 12 12)`}>
        {[NEAR, FAR].flatMap((y) =>
          [NEAR, FAR].map((x) => (
            <rect key={`${x}-${y}`} x={x} y={y} width={BLOCK} height={BLOCK} rx={0.8} />
          )),
        )}
      </g>
    </SvgIcon>
  );
}
