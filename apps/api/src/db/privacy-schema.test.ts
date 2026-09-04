import { describe, expect, it } from "vitest";
import {
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestEvent,
  dataSubjectRequestPreservation,
  dataSubjectRequestSourceSnapshot,
  dataSubjectRequestTask,
} from "./privacy-schema";

describe("privacy persistence schema", () => {
  it("defines the durable subject-access tables", () => {
    const name = (table: object) => (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")];
    expect(name(dataSubjectRequest)).toBe("data_subject_request");
    expect(name(dataSubjectRequestEvent)).toBe("data_subject_request_event");
    expect(name(dataSubjectRequestTask)).toBe("data_subject_request_task");
    expect(name(dataSubjectRequestPreservation)).toBe("data_subject_request_preservation");
    expect(name(dataSubjectRequestSourceSnapshot)).toBe("data_subject_request_source_snapshot");
    expect(name(dataExportArtifact)).toBe("data_export_artifact");
    expect(name(dataSubjectRequestAttachment)).toBe("data_subject_request_attachment");
  });
});
