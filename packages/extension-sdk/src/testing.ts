/**
 * Test utilities for OpenMapX integration authors.
 *
 * Import from `@openmapx/extension-sdk/testing` in your test files.
 */

export type {
  CapturedRegistrations,
  FakeHttpClient,
  MockContextOverrides,
  MockIntegrationContext,
} from "@openmapx/integration-framework/testing";
export {
  createMockIntegrationContext,
  createNoopLogger,
  createPassthroughCache,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
