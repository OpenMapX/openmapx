import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SOURCE_TAR_LIMITS, SourceTarReader } from "./source-tar-reader.js";

const execute = promisify(execFile);
const longPath = `${"nested/".repeat(20)}body.txt`;
const entries = [
  ["empty.txt", ""],
  ["manifest.json", '{"source":"interop"}\n'],
  [longPath, "a body spanning the USTAR name and prefix fields\n"],
] as const;

describe("source TAR writer interoperability", () => {
  it.each([
    {
      name: "Ruby Gem::Package::TarWriter",
      executable: "ruby",
      args: [
        "-rrubygems/package",
        "-rstringio",
        "-rjson",
        "-e",
        `output = StringIO.new("".b)
Gem::Package::TarWriter.new(output) do |tar|
  JSON.parse(ARGV.fetch(0)).each do |path, body|
    tar.add_file_simple(path, 0600, body.bytesize) { |file| file.write(body) }
  end
end
STDOUT.binmode.write(output.string)`,
      ],
    },
    {
      name: "Python tarfile USTAR_FORMAT",
      executable: "python3",
      args: [
        "-c",
        `import io, json, sys, tarfile
with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
    for path, text in json.loads(sys.argv[1]):
        body = text.encode("utf-8")
        member = tarfile.TarInfo(path)
        member.size = len(body)
        member.mode = 0o600
        archive.addfile(member, io.BytesIO(body))`,
      ],
    },
  ])("reads actual $name output", async ({ executable, args }) => {
    const { stdout } = await execute(executable, [...args, JSON.stringify(entries)], {
      encoding: "buffer",
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    const received: Array<[string, string]> = [];
    const reader = new SourceTarReader(
      // Split headers, bodies and EOF records independently of each writer's output chunks.
      Readable.from(
        (function* () {
          for (let offset = 0; offset < stdout.length; offset += 37) {
            yield stdout.subarray(offset, offset + 37);
          }
        })(),
      ),
      SOURCE_TAR_LIMITS,
      (code) => new Error(code),
    );
    await reader.read(async ({ path, bytes, content }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of content) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      expect(body.length).toBe(bytes);
      received.push([path, body.toString("utf8")]);
    });
    expect(received).toEqual(entries);
  });
});
