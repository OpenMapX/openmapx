export class ArtifactTransferError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 410 | 413 | 415 | 422 | 429 | 503 | 507,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactTransferError";
  }
}
