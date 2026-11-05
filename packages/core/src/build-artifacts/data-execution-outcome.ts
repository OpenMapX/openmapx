import {
  type DataExecutionResult,
  dataExecutionResultSchema,
} from "../services/data-manager/contracts/executions";
/** A trusted worker reports a completed publication with an incomplete optional
 * stage. This is an outcome, not containment authority: the journal still awaits
 * that worker and every child before signing its original terminal commitment. */
export class DataExecutionPartialResult extends Error {
  readonly result: DataExecutionResult;
  constructor(result: DataExecutionResult) {
    super("Data publication completed with an incomplete stage");
    this.result = dataExecutionResultSchema.parse(result);
  }
}
