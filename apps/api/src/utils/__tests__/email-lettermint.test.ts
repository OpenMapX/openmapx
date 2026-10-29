import { afterEach, describe, expect, it, vi } from "vitest";

const lettermintMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  send: vi.fn().mockResolvedValue({ message_id: "message-1", status: "pending" }),
}));

vi.mock("lettermint", () => ({
  Lettermint: class {
    readonly emails = { send: lettermintMocks.send };

    constructor(options: unknown) {
      lettermintMocks.construct(options);
    }
  },
}));

import { sendViaLettermint } from "../email";

const config: Parameters<typeof sendViaLettermint>[1] = {
  provider: "lettermint",
  from: "OpenMapX <noreply@example.com>",
  smtp: { host: "localhost", port: 587, secure: false, user: "", pass: "" },
  emaillabs: { appKey: "", secretKey: "", smtpAccount: "" },
  lettermint: { apiToken: "lm_project_token" },
};

describe("sendViaLettermint", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the stateless v3 sending surface without changing the message", async () => {
    await sendViaLettermint(
      {
        to: "person@example.com",
        subject: "Road closure update",
        text: "The road is closed.",
        html: "<p>The road is closed.</p>",
      },
      config,
    );

    expect(lettermintMocks.construct).toHaveBeenCalledWith({ sendingToken: "lm_project_token" });
    expect(lettermintMocks.send).toHaveBeenCalledWith({
      from: "OpenMapX <noreply@example.com>",
      to: ["person@example.com"],
      subject: "Road closure update",
      text: "The road is closed.",
      html: "<p>The road is closed.</p>",
    });
  });
});
