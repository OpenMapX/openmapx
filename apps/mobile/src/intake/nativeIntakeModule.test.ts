import { requireOptionalNativeModule } from "expo";
import { createNativeIntakePort } from "./nativeIntakeModule";

jest.mock("expo", () => ({ requireOptionalNativeModule: jest.fn() }));
const load = jest.mocked(requireOptionalNativeModule);
const id = "12345678-1234-4234-8234-123456789abc";
afterEach(() => jest.resetAllMocks());
it("does not crash an older binary without the module", async () => {
  load.mockReturnValue(null);
  const port = createNativeIntakePort();
  expect(await port.available()).toBe(false);
  await expect(port.list()).rejects.toMatchObject({ code: "unavailable" });
});
it("refuses native paths and malformed metadata at the module boundary", async () => {
  load.mockReturnValue({
    listAsync: async () => ({
      items: [
        {
          id,
          name: "route.gpx",
          kind: "file",
          format: "gpx",
          byteLength: 10,
          createdAtMs: 1,
          path: "/private/secret",
        },
      ],
    }),
  } as never);
  await expect(createNativeIntakePort().list()).rejects.toMatchObject({ code: "invalid-data" });
});
it("retains a closed native error code without its native exception text", async () => {
  load.mockReturnValue({ listAsync: async () => ({ errorCode: "inbox-full" }) } as never);
  await expect(createNativeIntakePort().list()).rejects.toMatchObject({
    code: "inbox-full",
    message: "inbox-full",
  });
});
it("validates chunk arguments before calling native and forwards only the opaque id", async () => {
  const readChunkAsync = jest
    .fn()
    .mockResolvedValue({ id, offset: 0, data: "YQ==", byteLength: 1, eof: true });
  const completeAsync = jest.fn().mockResolvedValue({ ok: true });
  load.mockReturnValue({ readChunkAsync, completeAsync } as never);
  const port = createNativeIntakePort();
  await expect(port.read("../secret", 0)).rejects.toMatchObject({ code: "invalid-data" });
  expect(readChunkAsync).not.toHaveBeenCalled();
  expect((await port.read(id, 0)).data).toBe("YQ==");
  await port.complete(id);
  expect(completeAsync).toHaveBeenCalledWith(id);
});
