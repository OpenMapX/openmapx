import type { AirQualityRejectionReason } from "./types";

export class AirQualityDomainError extends Error {
  constructor(
    readonly code: AirQualityRejectionReason,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AirQualityDomainError";
  }
}
