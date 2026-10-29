import { Unzip, UnzipInflate } from "fflate";
import { parseCsv } from "./csv";
import { isSavedPlacesJson, parseGeojson } from "./geojson";
import { parseGpx } from "./gpx";
import { parseKml } from "./kml";
import {
  fileList,
  ImportFileError,
  type ImportList,
  type ParsedImport,
  type ParseOptions,
} from "./types";

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export function parseImportText(
  filename: string,
  input: string,
  options: ParseOptions = {},
  takeoutOnly = false,
): ImportList[] {
  const extension = filename.split(".").pop()?.toLowerCase();
  let lists: ImportList[];
  try {
    if (extension === "csv") lists = parseCsv(input, filename, options, takeoutOnly);
    else if (extension === "json" || extension === "geojson") {
      const data: unknown = JSON.parse(input.replace(/^\uFEFF/, ""));
      lists = takeoutOnly && !isSavedPlacesJson(data) ? [] : parseGeojson(data, filename, options);
    } else if (extension === "kml") lists = parseKml(input, filename, options);
    else if (extension === "gpx") lists = parseGpx(input, filename, options);
    else throw new ImportFileError("unsupported");
  } catch (error) {
    throw error instanceof ImportFileError ? error : new ImportFileError("malformed");
  }
  const nonempty = lists.filter((list) => list.places.length > 0);
  if (!nonempty.length && (!takeoutOnly || extension === "csv")) throw new ImportFileError("empty");
  return nonempty;
}
async function archive(file: File, options: ParseOptions): Promise<ParsedImport> {
  let total = 0;
  let count = 0;
  let failure: Error | undefined;
  const kmz = file.name.toLowerCase().endsWith(".kmz");
  let takeout = false;
  let hasSavedContent = false;
  const savedCsv = (path: string) => /(?:^|\/)(?:saved|gespeichert)\/.*\.csv$/i.test(path);
  const data = new Uint8Array(await file.arrayBuffer());
  options.signal?.throwIfAborted();
  const entries: { path: string; chunks: Uint8Array[]; size: number }[] = [];
  const unzip = new Unzip((entry) => {
    if (++count > MAX_ENTRIES) failure = new ImportFileError("tooLarge");
    takeout ||= /^Takeout\//i.test(entry.name);
    hasSavedContent ||= savedCsv(entry.name) || /(?:^|\/)Saved Places\.json$/i.test(entry.name);
    const relevant = kmz
      ? /\.kml$/i.test(entry.name)
      : (/\.json$/i.test(entry.name) &&
          !/(?:^|\/)(?:Labelled places|Labeled places|Reviews)\.json$/i.test(entry.name)) ||
        savedCsv(entry.name);
    if (failure || !relevant) return;
    const extracted = { path: entry.name, chunks: [] as Uint8Array[], size: 0 };
    entries.push(extracted);
    entry.ondata = (error, chunk) => {
      if (failure) return;
      if (error) {
        failure = error;
        return;
      }
      total += chunk.byteLength;
      if (total > MAX_BYTES) {
        failure = new ImportFileError("tooLarge");
        entry.terminate();
        return;
      }
      extracted.chunks.push(chunk);
      extracted.size += chunk.byteLength;
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  // Bound each inflate call as well as the retained output, regardless of ZIP size headers.
  for (let offset = 0; offset < data.length; offset += 1024) {
    options.signal?.throwIfAborted();
    unzip.push(data.subarray(offset, offset + 1024), offset + 1024 >= data.length);
    if (failure) throw failure;
    if (offset % (64 * 1024) === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const result: ParsedImport = { lists: [], errors: [], skippedLists: [] };
  for (const { path, chunks, size } of entries) {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    options.signal?.throwIfAborted();
    const source = `${file.name}/${path}`;
    try {
      result.lists.push(
        ...parseImportText(path, new TextDecoder().decode(bytes), options, !kmz).map((list) => ({
          ...list,
          source,
        })),
      );
    } catch (error) {
      if (!kmz && savedCsv(path) && error instanceof ImportFileError && error.code === "empty") {
        result.skippedLists.push(fileList(path, [], path).name);
        continue;
      }
      // Other Takeout products also contain JSON; only recognized saved content is relevant.
      if (kmz || /saved places|saved\/|gespeichert\//i.test(path))
        result.errors.push({
          file: source,
          code: error instanceof ImportFileError ? error.code : "malformed",
        });
    }
  }
  if (!result.lists.length && !result.errors.length && !result.skippedLists.length)
    result.errors.push({
      file: file.name,
      code: !kmz && takeout && !hasSavedContent ? "takeoutNoSaved" : "empty",
    });
  return result;
}
export async function parseImportFiles(
  files: readonly File[],
  options: ParseOptions = {},
): Promise<ParsedImport> {
  const result: ParsedImport = { lists: [], errors: [], skippedLists: [] };
  for (let i = 0; i < files.length; i++) {
    options.signal?.throwIfAborted();
    const file = files[i];
    try {
      if (file.size > MAX_BYTES) throw new ImportFileError("tooLarge");
      if (/\.(zip|kmz)$/i.test(file.name)) {
        const parsed = await archive(file, options);
        result.lists.push(...parsed.lists);
        result.errors.push(...parsed.errors);
        result.skippedLists.push(...parsed.skippedLists);
      } else {
        const input = await file.text();
        options.signal?.throwIfAborted();
        result.lists.push(...parseImportText(file.name, input, options));
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      result.errors.push({
        file: file.name,
        code: error instanceof ImportFileError ? error.code : "malformed",
      });
    }
    options.onProgress?.(i + 1, files.length);
  }
  return result;
}
