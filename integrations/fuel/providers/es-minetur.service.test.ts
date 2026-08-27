import { afterEach, describe, expect, it, vi } from "vitest";
import { EsMineturService } from "./es-minetur.service";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Spanish fuel bulk feed", () => {
  it("accepts the reviewed nationwide feed size while still using a bounded response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ListaEESSPrecio: [
                {
                  IDEESS: "1",
                  Rótulo: "Test fuel",
                  Dirección: "Calle 1",
                  Municipio: "Madrid",
                  Latitud: "40,4168",
                  "Longitud (WGS84)": "-3,7038",
                  "Precio Gasoleo A": "1,50",
                  "Precio Gasolina 95 E5": "1,60",
                  "Precio Gasolina 95 E10": "",
                  "Precio Gasolina 98 E5": "",
                  "Precio Gases licuados del petróleo": "",
                },
              ],
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": "12113133",
              },
            },
          ),
      ),
    );

    await expect(
      new EsMineturService().searchStations({ west: -3.8, south: 40.3, east: -3.6, north: 40.5 }),
    ).resolves.toEqual([expect.objectContaining({ id: "es-minetur/1", name: "Test fuel" })]);
  });
});
