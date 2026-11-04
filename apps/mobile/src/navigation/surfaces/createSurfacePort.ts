import { requireOptionalNativeModule } from "expo";
import { AppState } from "react-native";
import { getRuntimeConfig } from "../../config/runtimeConfig";
import type { SessionRepository } from "../../storage/SessionRepository";
import { SurfaceController } from "./SurfaceController";
import { SURFACE_BYTES } from "./surfaceModel";

interface NativeSurfaces {
  updateAsync(payload: string, scheme: string, foreground: boolean): Promise<boolean>;
  clearAsync(expectedOwner: string | null): Promise<void>;
}
let controller: SurfaceController | null = null;
function getController(): SurfaceController {
  controller ??= new SurfaceController({
    update: async (model, foreground) => {
      const payload = JSON.stringify(model);
      if (new TextEncoder().encode(payload).byteLength > SURFACE_BYTES) return false;
      const native = requireOptionalNativeModule<NativeSurfaces>("OpenMapXNavigationSurfaces");
      return native
        ? native.updateAsync(payload, getRuntimeConfig().scheme.toLowerCase(), foreground)
        : false;
    },
    clear: async (owner) => {
      await requireOptionalNativeModule<NativeSurfaces>("OpenMapXNavigationSurfaces")?.clearAsync(
        owner,
      );
    },
  });
  return controller;
}
/** Called under the caller's authority ordering, but uses an independent OS FIFO. */
export async function reconcileNavigationSurface(
  repository: SessionRepository,
  visible = AppState.currentState === "active",
): Promise<void> {
  await getController().reconcile(await repository.loadActive(Date.now()), visible);
}
export function clearNavigationSurface(): Promise<void> {
  return getController().reconcile(null, false);
}
export function settleSurfaces(): Promise<void> {
  return getController().settle();
}
