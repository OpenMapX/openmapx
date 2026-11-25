/** Portable identifier schemas shared by inputs and browser-visible results. */
import { z } from "zod";
import { COMPONENT_ID_PATTERN } from "../component-id";
export const serviceIdSchema = z.string().regex(COMPONENT_ID_PATTERN);
export const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const configurationGenerationRevisionSchema = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
