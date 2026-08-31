const DEFAULT_BUCKET_SIZE_DEGREES = 0.002;
const METERS_PER_LATITUDE_DEGREE = 111_320;
const MINIMUM_LATITUDE_COSINE = 0.01;

export interface SpatialClusteringOptions<T> {
  coordinates: (item: T) => readonly [longitude: number, latitude: number];
  searchRadiusMeters: number;
  shouldJoin: (first: T, second: T) => boolean;
}

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = new Array(size).fill(0);
  }

  find(index: number): number {
    if (this.parent[index] !== index) this.parent[index] = this.find(this.parent[index]);
    return this.parent[index];
  }

  union(first: number, second: number): void {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot === secondRoot) return;

    if (this.rank[firstRoot] < this.rank[secondRoot]) {
      this.parent[firstRoot] = secondRoot;
    } else if (this.rank[firstRoot] > this.rank[secondRoot]) {
      this.parent[secondRoot] = firstRoot;
    } else {
      this.parent[secondRoot] = firstRoot;
      this.rank[firstRoot]++;
    }
  }
}

function bucketKey(coordinates: readonly [number, number]): string {
  const [longitude, latitude] = coordinates;
  return `${Math.floor(longitude / DEFAULT_BUCKET_SIZE_DEGREES)},${Math.floor(latitude / DEFAULT_BUCKET_SIZE_DEGREES)}`;
}

function neighborKeys(key: string, latitude: number, searchRadiusMeters: number): string[] {
  const [longitudeBucket, latitudeBucket] = key.split(",").map(Number);
  const cosine = Math.max(Math.abs(Math.cos((latitude * Math.PI) / 180)), MINIMUM_LATITUDE_COSINE);
  const longitudeDegrees = searchRadiusMeters / (METERS_PER_LATITUDE_DEGREE * cosine);
  const latitudeDegrees = searchRadiusMeters / METERS_PER_LATITUDE_DEGREE;
  const longitudeRange = Math.ceil(longitudeDegrees / DEFAULT_BUCKET_SIZE_DEGREES) + 1;
  const latitudeRange = Math.ceil(latitudeDegrees / DEFAULT_BUCKET_SIZE_DEGREES);
  const keys: string[] = [];

  for (
    let longitudeOffset = -longitudeRange;
    longitudeOffset <= longitudeRange;
    longitudeOffset++
  ) {
    for (let latitudeOffset = -latitudeRange; latitudeOffset <= latitudeRange; latitudeOffset++) {
      keys.push(`${longitudeBucket + longitudeOffset},${latitudeBucket + latitudeOffset}`);
    }
  }
  return keys;
}

function clustersAreCompatible<T>(
  first: number[],
  second: number[],
  items: readonly T[],
  shouldJoin: (first: T, second: T) => boolean,
): boolean {
  for (const firstIndex of first) {
    for (const secondIndex of second) {
      if (!shouldJoin(items[firstIndex], items[secondIndex])) return false;
    }
  }
  return true;
}

export function clusterSpatialItems<T>(
  items: readonly T[],
  options: SpatialClusteringOptions<T>,
): T[][] {
  if (items.length === 0) return [];

  if (!Number.isFinite(options.searchRadiusMeters) || options.searchRadiusMeters <= 0) {
    throw new RangeError("searchRadiusMeters must be a positive finite number");
  }

  const buckets = new Map<string, number[]>();
  for (let index = 0; index < items.length; index++) {
    const key = bucketKey(options.coordinates(items[index]));
    const members = buckets.get(key);
    if (members) members.push(index);
    else buckets.set(key, [index]);
  }

  const unionFind = new UnionFind(items.length);
  const clusterMembers = new Map<number, number[]>();
  for (let index = 0; index < items.length; index++) clusterMembers.set(index, [index]);

  for (let index = 0; index < items.length; index++) {
    const coordinates = options.coordinates(items[index]);
    const key = bucketKey(coordinates);
    const candidates = neighborKeys(key, coordinates[1], options.searchRadiusMeters);
    for (const candidateKey of candidates) {
      const candidateIndexes = buckets.get(candidateKey);
      if (!candidateIndexes) continue;

      for (const candidateIndex of candidateIndexes) {
        if (candidateIndex <= index || !options.shouldJoin(items[index], items[candidateIndex])) {
          continue;
        }

        const firstRoot = unionFind.find(index);
        const secondRoot = unionFind.find(candidateIndex);
        if (firstRoot === secondRoot) continue;

        const firstMembers = clusterMembers.get(firstRoot);
        const secondMembers = clusterMembers.get(secondRoot);
        if (
          !firstMembers ||
          !secondMembers ||
          !clustersAreCompatible(firstMembers, secondMembers, items, options.shouldJoin)
        ) {
          continue;
        }

        unionFind.union(index, candidateIndex);
        const root = unionFind.find(index);
        const mergedMembers = [...firstMembers, ...secondMembers];
        if (root !== firstRoot) clusterMembers.delete(firstRoot);
        if (root !== secondRoot) clusterMembers.delete(secondRoot);
        clusterMembers.set(root, mergedMembers);
      }
    }
  }

  const clusters = new Map<number, T[]>();
  for (let index = 0; index < items.length; index++) {
    const root = unionFind.find(index);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(items[index]);
    else clusters.set(root, [items[index]]);
  }
  return Array.from(clusters.values());
}
