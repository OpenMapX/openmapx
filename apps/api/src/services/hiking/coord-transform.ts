const R = 20037508.34;

export function lngToMercatorX(lng: number): number {
  return (lng * R) / 180;
}

export function latToMercatorY(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) * R;
}

export function bboxToMercator(
  south: number,
  west: number,
  north: number,
  east: number,
): [number, number, number, number] {
  return [lngToMercatorX(west), latToMercatorY(south), lngToMercatorX(east), latToMercatorY(north)];
}
