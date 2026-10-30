import { savedOperations } from "./contracts/saved";
import { createOperationBinder } from "./operation-transport";

export type { OperationRequestOptions } from "./operation-transport";
export { unwrapOperationResponse as unwrapSavedResponse } from "./operation-transport";
export const bindSavedOperation = createOperationBinder(savedOperations);
