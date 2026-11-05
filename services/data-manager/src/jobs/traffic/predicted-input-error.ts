/** Produced only by the predicted bake's read-only input stage, before any
 * map refresh, file publication or host operation is attempted. */
export class PredictedTrafficInputError extends Error {
  constructor(cause: unknown) {
    super("Predicted traffic inputs are unavailable", { cause });
  }
}
