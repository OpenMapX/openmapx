/** A translator a helper outside a component receives from the component that calls it. */
export type AdminTranslator = (key: string, values?: Record<string, string | number>) => string;
