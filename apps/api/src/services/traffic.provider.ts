export interface TrafficTile {
  contentType: string;
  cacheControl?: string;
  bytes: ArrayBuffer;
}

export class TrafficProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "TrafficProviderHttpError";
  }
}

export interface TrafficProvider {
  getFlowTile: (z: number, x: number, y: number) => Promise<TrafficTile>;
}
