import type { AppVisibility } from "./lifecyclePolicy";

/** WebView does not forward the host's pause/resume to Page Visibility on Android. */
export function buildWebVisibilityScript(visibility: AppVisibility): string {
  const state = visibility === "active" ? "visible" : "hidden";
  return `(function(){
var state="${state}";
var changed=document.visibilityState!==state;
Object.defineProperty(document,"visibilityState",{configurable:true,get:function(){return state;}});
Object.defineProperty(document,"hidden",{configurable:true,get:function(){return state==="hidden";}});
if(changed)document.dispatchEvent(new Event("visibilitychange",{bubbles:true}));
})();true;`;
}
