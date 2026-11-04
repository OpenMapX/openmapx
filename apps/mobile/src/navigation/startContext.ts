export type NavigationStartContext =
  | { kind: "phone"; activityVisible: boolean }
  | { kind: "car"; hostAuthorized: boolean; locationServiceStartAllowed: boolean }
  | { kind: "background" };
export function allowsNavigationStart(
  context: NavigationStartContext,
  permission: string,
): boolean {
  if (context.kind === "phone") return context.activityVisible;
  return (
    context.kind === "car" &&
    context.hostAuthorized &&
    context.locationServiceStartAllowed &&
    permission === "background"
  );
}
