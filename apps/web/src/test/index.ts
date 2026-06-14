// Shared web test toolkit. (setup.ts is the jsdom project's setupFile and is
// not re-exported here.)

export * from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
export {
  type CreateFakeMapOptions,
  createFakeMap,
  type FakeMap,
  type FakeMapState,
} from "./fakeMap";
export { mockNextIntl, renderWithIntl } from "./intl";
export {
  createQueryWrapper,
  createTestQueryClient,
  renderHookWithQuery,
} from "./query";
