declare module "hafas-client" {
  // biome-ignore lint/suspicious/noExplicitAny: external untyped library
  function createClient(profile: Record<string, any>, userAgent: string): any;
}
