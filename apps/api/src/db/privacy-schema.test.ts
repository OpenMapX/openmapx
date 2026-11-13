import { describe, expect, it } from "vitest";
import * as privacySchema from "./privacy-schema";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestNotification,
  dataSubjectRequestPreservation,
  dataSubjectRequestTask,
} from "./privacy-schema";

describe("privacy persistence schema", () => {
  it("defines only the durable subject-access tables", () => {
    const name = (table: object) => (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")];
    expect(name(dataSubjectRequest)).toBe("data_subject_request");
    expect(name(dataSubjectRequestEvent)).toBe("data_subject_request_event");
    expect(name(dataSubjectRequestTask)).toBe("data_subject_request_task");
    expect(name(dataSubjectRequestPreservation)).toBe("data_subject_request_preservation");
    expect(name(dataSubjectRequestNotification)).toBe("data_subject_request_notification");
    const tables = Object.values(privacySchema).filter(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        Symbol.for("drizzle:Name") in (value as unknown as Record<symbol, unknown>),
    );
    expect(tables).toHaveLength(5);
  });
});
