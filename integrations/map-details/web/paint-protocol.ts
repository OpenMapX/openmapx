import { type AddProtocolAction, addProtocol } from "maplibre-gl";
import type { MapDetailsWorkerClient } from "./worker-client";

export const PAINT_PROTOCOL = "openmapx-street-detail";
export const PAINT_SOURCE_ID = "openmapx-street-detail";
export const PAINT_TEMPLATE = `${PAINT_PROTOCOL}://{z}/{x}/{y}`;

const empty = () => ({ data: new ArrayBuffer(0) });

/**
 * The protocol behind the street paint source: the worker derives the z16
 * parent once and encodes the requested z16–18 tile. Missing street data, a
 * missing worker or a failure answer an empty tile; failures are logged once.
 */
export function createPaintProtocolHandler(
  getClient: () => MapDetailsWorkerClient | null,
  getTemplate: () => string | null,
): AddProtocolAction {
  let warned = false;
  return async (params, controller) => {
    const match = /^[a-z-]+:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const client = getClient();
    const template = getTemplate();
    if (!match || !client || !template) return empty();
    try {
      const bytes = await client.paint(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        template,
        controller.signal,
      );
      return bytes ? { data: bytes } : empty();
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn("Street detail tiles are unavailable", error);
      }
      return empty();
    }
  };
}

let readers: { client: () => MapDetailsWorkerClient | null; template: () => string | null } | null =
  null;

/** Register the paint protocol once per page; later calls update its readers. */
export function ensurePaintProtocol(
  getClient: () => MapDetailsWorkerClient | null,
  getTemplate: () => string | null,
): void {
  const first = readers === null;
  readers = { client: getClient, template: getTemplate };
  if (!first) return;
  addProtocol(
    PAINT_PROTOCOL,
    createPaintProtocolHandler(
      () => readers?.client() ?? null,
      () => readers?.template() ?? null,
    ),
  );
}
