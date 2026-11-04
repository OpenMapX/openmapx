/** The installed shell's app state, as React Native's AppState reports it. */
export type ShellAppVisibility = "active" | "inactive" | "background";

/**
 * Script the installed shell injects into its page to mirror the app state onto
 * Page Visibility. Android's WebView does not forward the host's pause and
 * resume, so without it the page never becomes hidden. It lives here because
 * the shell injects it and the page's tests run it.
 */
export function buildWebVisibilityScript(visibility: ShellAppVisibility): string {
  const state = visibility === "active" ? "visible" : "hidden";
  return `(function(){
var state="${state}";
var changed=document.visibilityState!==state;
Object.defineProperty(document,"visibilityState",{configurable:true,get:function(){return state;}});
Object.defineProperty(document,"hidden",{configurable:true,get:function(){return state==="hidden";}});
if(changed)document.dispatchEvent(new Event("visibilitychange",{bubbles:true}));
})();true;`;
}
