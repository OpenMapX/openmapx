import { ImportFileError } from "./types";

export function xml(input: string, root: string): Document {
  const doc = new DOMParser().parseFromString(input, "application/xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName.toLowerCase() !== root)
    throw new ImportFileError("malformed");
  return doc;
}
export function elements(parent: Document | Element, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS("*", localName));
}
export function childText(parent: Element, localName: string): string {
  return (
    Array.from(parent.children)
      .find((e) => e.localName === localName)
      ?.textContent?.trim() || ""
  );
}
export function plainText(input: string): string {
  const doc = new DOMParser().parseFromString(input, "text/html");
  for (const element of doc.querySelectorAll("script,style,iframe,object")) element.remove();
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of doc.querySelectorAll("p,div,li")) block.append("\n");
  return (doc.body.textContent || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}
