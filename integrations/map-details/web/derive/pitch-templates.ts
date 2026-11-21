import { bufferPolyline, type Pt, type Ring } from "./geometry";

/**
 * Sports pitch line templates (spec §5.7; IFAB Law 1, ITF, FIBA). Template
 * coordinates are metres, centred, with the long axis along +y and +x across.
 * Lines are centre-line polylines; `strokeLines` widens them to 0.1 m rings.
 */

const LINE_HALF_WIDTH_M = 0.05;
const MARK_RADIUS_M = 0.11;

const rectangle = (halfU: number, halfV: number): Pt[] => [
  [-halfU, -halfV],
  [halfU, -halfV],
  [halfU, halfV],
  [-halfU, halfV],
  [-halfU, -halfV],
];

function arc(centre: Pt, radius: number, from: number, to: number, steps = 32): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = from + ((to - from) * i) / steps;
    return [centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius];
  });
}

const circle = (centre: Pt, radius: number, steps = 48) =>
  arc(centre, radius, 0, 2 * Math.PI, steps);

export function strokeLines(lines: Pt[][]): Ring[] {
  return lines.flatMap((line) => bufferPolyline(line, LINE_HALF_WIDTH_M));
}

export interface SoccerLines {
  boundary: Pt[][];
  halfway: Pt[][];
  centreCircle: Pt[][];
  centreMark: Pt[][];
  penaltyAreas: Pt[][];
  goalAreas: Pt[][];
  penaltyMarks: Pt[][];
  cornerArcs: Pt[][];
}

/** Football markings on a `length` × `width` pitch; fixed distances scale by min(1, length / 105). */
export function soccerLines(length: number, width: number): SoccerLines {
  const s = Math.min(1, length / 105);
  const halfL = length / 2;
  const halfW = width / 2;
  const box = (end: number, halfWidth: number, depth: number): Pt[] => {
    const u = Math.min(halfWidth, halfW);
    return [
      [-u, end * halfL],
      [-u, end * (halfL - depth)],
      [u, end * (halfL - depth)],
      [u, end * halfL],
    ];
  };
  const ends = [-1, 1];
  return {
    boundary: [rectangle(halfW, halfL)],
    halfway: [
      [
        [-halfW, 0],
        [halfW, 0],
      ],
    ],
    centreCircle: [circle([0, 0], 9.15 * s)],
    centreMark: [circle([0, 0], MARK_RADIUS_M, 8)],
    penaltyAreas: ends.map((end) => box(end, 20.16 * s, 16.5 * s)),
    goalAreas: ends.map((end) => box(end, 9.16 * s, 5.5 * s)),
    penaltyMarks: ends.map((end) => circle([0, end * (halfL - 11 * s)], MARK_RADIUS_M, 8)),
    cornerArcs: [
      arc([-halfW, -halfL], s, 0, Math.PI / 2, 8),
      arc([halfW, -halfL], s, Math.PI / 2, Math.PI, 8),
      arc([halfW, halfL], s, Math.PI, (3 * Math.PI) / 2, 8),
      arc([-halfW, halfL], s, (3 * Math.PI) / 2, 2 * Math.PI, 8),
    ],
  };
}

export const TENNIS_LENGTH_M = 23.77;
export const TENNIS_WIDTH_M = 10.97;

/** One regulation tennis court, centred. */
export function tennisLines(): Pt[][] {
  const halfL = TENNIS_LENGTH_M / 2;
  const singles = 8.23 / 2;
  const service = 6.4;
  return [
    rectangle(TENNIS_WIDTH_M / 2, halfL),
    [
      [-singles, -halfL],
      [-singles, halfL],
    ],
    [
      [singles, -halfL],
      [singles, halfL],
    ],
    [
      [-singles, -service],
      [singles, -service],
    ],
    [
      [-singles, service],
      [singles, service],
    ],
    [
      [0, -service],
      [0, service],
    ],
    [
      [0, -halfL],
      [0, -halfL + 0.1],
    ],
    [
      [0, halfL],
      [0, halfL - 0.1],
    ],
  ];
}

/** A basketball court (28 × 15 m) scaled down to fit `length` × `width`. */
export function basketballLines(length: number, width: number): Pt[][] {
  const s = Math.min(1, length / 28, width / 15);
  const halfL = 14 * s;
  const halfW = 7.5 * s;
  const lines: Pt[][] = [
    rectangle(halfW, halfL),
    [
      [-halfW, 0],
      [halfW, 0],
    ],
    circle([0, 0], 1.8 * s),
  ];
  for (const end of [-1, 1]) {
    const keyHalf = 2.45 * s;
    lines.push([
      [-keyHalf, end * halfL],
      [-keyHalf, end * (halfL - 5.8 * s)],
      [keyHalf, end * (halfL - 5.8 * s)],
      [keyHalf, end * halfL],
    ]);
    const basket = end * (halfL - 1.575 * s);
    const radius = 6.75 * s;
    const straight = halfW - 0.9 * s;
    const meet = Math.sqrt(Math.max(radius * radius - straight * straight, 0));
    const start = Math.atan2(-end * meet, -straight);
    const finish = Math.atan2(-end * meet, straight);
    // Both angles lie on the court side of the basket, so a direct sweep bulges towards half court.
    const sweep = arc([0, basket], radius, start, finish);
    lines.push([[-straight, end * halfL], ...sweep, [straight, end * halfL]]);
  }
  return lines;
}

/** Regulation-size templates as 0.1 m line rings. */
export const PITCH_TEMPLATES: { soccer: Ring[]; tennis: Ring[]; basketball: Ring[] } = {
  soccer: strokeLines(Object.values(soccerLines(105, 68)).flat()),
  tennis: strokeLines(tennisLines()),
  basketball: strokeLines(basketballLines(28, 15)),
};
