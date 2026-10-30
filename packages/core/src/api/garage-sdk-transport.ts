import { garageOperations } from "./contracts/garage";
import { createOperationBinder } from "./operation-transport";

export type { OperationRequestOptions } from "./operation-transport";
export { unwrapOperationResponse as unwrapGarageResponse } from "./operation-transport";
export const bindGarageOperation = createOperationBinder(garageOperations);
