/** Check the installed SDK's event origin, including ordering before page code. */
export function hasWebViewDocumentStartPolicy(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const method = (name: string) =>
    (code.split(`public void ${name} (`)[1] ?? code.split(`public void ${name}(`)[1] ?? "")
      .split("@Override")[0]
      .replace(/\s+/g, " ");
  const start = method("onPageStarted");
  const history = method("doUpdateVisitedHistory");
  const taggedBeforeDelivery = (body: string, tag: boolean) => {
    const flag = body.indexOf(`event.putBoolean("openmapxDocumentStart", ${tag});`);
    const delivery = body.indexOf("new TopLoadingStartEvent(");
    return flag >= 0 && delivery > flag && body.slice(delivery).includes(", event)");
  };
  return (
    taggedBeforeDelivery(start, true) &&
    start.indexOf("callInjectedJavaScriptBeforeContentLoaded()") >
      start.indexOf("new TopLoadingStartEvent(") &&
    taggedBeforeDelivery(history, false)
  );
}
