import { describe, expect, it } from "vitest";
import type { BridgeClient } from "./bridgeClient";
import { BridgeError, NativeCommandError } from "./bridgeClient";
import { CommandError, NativeNavigationCommands } from "./navigationCommands";

interface Call {
  type: string;
  payload: unknown;
  options: { sessionId?: string; revision?: number; timeoutMs?: number };
}

/**
 * A client that answers whatever the test queues, recording every request. Each
 * answer may be a message, an error to throw, or a deferred handle the test
 * settles by hand — the last is how ordering is observed.
 */
function fakeClient() {
  const calls: Call[] = [];
  const answers = new Map<string, () => Promise<unknown>>();

  const reply = (type: string, payload: unknown = {}) => ({ type, payload });

  const client = {
    request: (type: string, payload: unknown, options: Call["options"] = {}) => {
      calls.push({ type, payload, options });
      const answer = answers.get(type);
      if (answer) return answer() as Promise<never>;
      return Promise.resolve(reply(replyTypeFor(type)) as never);
    },
  } as unknown as BridgeClient;

  return { client, calls, answers, reply };
}

function replyTypeFor(type: string): string {
  switch (type) {
    case "session.prepare":
      return "session.prepared";
    case "session.start":
      return "session.started";
    case "session.replace":
      return "session.replaced";
    case "session.stop":
    case "session.complete":
      return "session.stopped";
    default:
      return "snapshot.update";
  }
}

const acknowledged =
  (sessionId: string | null = "s1", revision: number | null = 4) =>
  () => ({
    sessionId,
    revision,
  });

function deferred<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

describe("NativeNavigationCommands start", () => {
  it("prepares before it starts", async () => {
    const { client, calls, answers, reply } = fakeClient();
    answers.set("session.prepare", async () =>
      reply("session.prepared", { sessionId: "s1", revision: 1 }),
    );
    answers.set("session.start", async () =>
      reply("session.started", { sessionId: "s1", revision: 2 }),
    );

    const started = await new NativeNavigationCommands(client, acknowledged()).start({ any: 1 });

    expect(calls.map((call) => call.type)).toEqual(["session.prepare", "session.start"]);
    expect(started).toEqual({ sessionId: "s1", revision: 2 });
  });

  it("runs the permission flow between prepare and start", async () => {
    const { client, calls } = fakeClient();
    const order: string[] = [];

    await new NativeNavigationCommands(client, acknowledged()).start({}, async () => {
      order.push(`permission after ${calls.length} calls`);
    });

    // Prompting before the shell accepted the package would spend the user's one
    // prompt on a trip that may never start.
    expect(order).toEqual(["permission after 1 calls"]);
    expect(calls[1].type).toBe("session.start");
  });

  it("never starts when the permission flow throws", async () => {
    const { client, calls } = fakeClient();

    await expect(
      new NativeNavigationCommands(client, acknowledged()).start({}, async () => {
        throw new Error("denied");
      }),
    ).rejects.toBeInstanceOf(CommandError);

    expect(calls.map((call) => call.type)).toEqual(["session.prepare"]);
  });

  it("reconciles a timed-out start without holding the caller on the snapshot", async () => {
    const { client, calls, answers, reply } = fakeClient();
    const snapshot = deferred<unknown>();
    answers.set("session.start", async () => {
      throw new BridgeError("timeout");
    });
    answers.set("snapshot.request", () => snapshot.promise);
    const commands = new NativeNavigationCommands(client, acknowledged());

    await expect(commands.start({})).rejects.toMatchObject({ code: "timeout" });
    expect(calls.map((call) => call.type)).toEqual([
      "session.prepare",
      "session.start",
      "snapshot.request",
    ]);
    snapshot.settle(reply("snapshot.update"));
  });

  it("reports an unexpected answer as a refusal rather than a session", async () => {
    const { client, answers, reply } = fakeClient();
    answers.set("session.prepare", async () => reply("session.stopped", {}));

    await expect(
      new NativeNavigationCommands(client, acknowledged()).start({}),
    ).rejects.toBeInstanceOf(CommandError);
  });
});

describe("NativeNavigationCommands failure classification", () => {
  it.each([
    { label: "incompatible", from: "incompatible", to: "incompatible" },
    { label: "a timeout", from: "timeout", to: "timeout" },
    { label: "a lost transport", from: "no-transport", to: "unavailable" },
    { label: "a channel reset", from: "channel-reset", to: "unavailable" },
  ])("maps $label", async ({ from, to }) => {
    const { client, answers } = fakeClient();
    answers.set("session.prepare", async () => {
      throw new BridgeError(from as never);
    });

    // "Try again" and "this shell will never do it" need different UI.
    const code = await new NativeNavigationCommands(client, acknowledged()).start({}).then(
      () => "resolved",
      (error: CommandError) => error.code,
    );

    expect(code).toBe(to);
  });
});

describe("NativeNavigationCommands refusals", () => {
  function refusing(type: string, code: string) {
    const { client, answers } = fakeClient();
    answers.set(type, async () => {
      throw new NativeCommandError(code);
    });
    return new NativeNavigationCommands(client, acknowledged());
  }

  it("rejects End when the shell refuses, keeping the shell's reason", async () => {
    const failure = await refusing("session.stop", "internal-error")
      .stop()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandError);
    expect(failure).toMatchObject({ code: "rejected", nativeCode: "internal-error" });
  });

  it.each(["transit.action", "transit.walk-route"])(
    "rejects %s when the shell refuses",
    async (type) => {
      const commands = refusing(type, "invalid-state");
      const action =
        type === "transit.action"
          ? commands.transitAction({
              actionId: "a1",
              itineraryFingerprint: "f",
              expectedPhase: "riding",
              type: "alight",
              legIndex: 1,
            })
          : commands.repairTransitWalk("f", 0, {});

      await expect(action).rejects.toMatchObject({ code: "rejected", nativeCode: "invalid-state" });
    },
  );

  it("reports a denied permission at start as such", async () => {
    const { client, answers } = fakeClient();
    answers.set("session.start", async () => {
      throw new NativeCommandError("permission-denied");
    });

    await expect(
      new NativeNavigationCommands(client, acknowledged()).start({}),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("treats no session as done for End and for a settings change", async () => {
    await expect(refusing("session.stop", "no-session").stop()).resolves.toBeUndefined();
    await expect(
      refusing("settings.update", "no-session").updateSettings({ voiceEnabled: false }),
    ).resolves.toBeUndefined();
  });

  it("rejects a settings change the shell refuses for another reason", async () => {
    await expect(
      refusing("settings.update", "revision-conflict").updateSettings({ voiceEnabled: false }),
    ).rejects.toMatchObject({ nativeCode: "revision-conflict" });
  });
});

describe("NativeNavigationCommands serialization", () => {
  it("runs mutations one at a time", async () => {
    const { client, calls, answers, reply } = fakeClient();
    const slow = deferred<unknown>();
    answers.set("session.prepare", () => slow.promise);

    const commands = new NativeNavigationCommands(client, acknowledged());
    const starting = commands.start({});
    const stopping = commands.stop();
    // The queue is a promise chain, so the first task runs a microtask later.
    await Promise.resolve();

    // Two sessions racing means one nobody is watching still holds a location
    // subscription.
    expect(calls.map((call) => call.type)).toEqual(["session.prepare"]);
    slow.settle(reply("session.prepared", {}));
    await starting;
    await stopping;
    expect(calls.map((call) => call.type)).toEqual([
      "session.prepare",
      "session.start",
      "session.stop",
    ]);
  });

  it("sends a settings change made during a start once the session exists", async () => {
    const { client, calls, answers, reply } = fakeClient();
    const slow = deferred<unknown>();
    answers.set("session.prepare", () => slow.promise);

    // Before the first snapshot the page knows no session to stamp.
    const commands = new NativeNavigationCommands(client, acknowledged(null, null));
    const starting = commands.start({});
    const settings = commands.updateSettings({ keepScreenOn: false });
    await Promise.resolve();
    slow.settle(reply("session.prepared", {}));
    await starting;
    await settings;

    expect(calls.map((call) => call.type)).toEqual([
      "session.prepare",
      "session.start",
      "settings.update",
    ]);
    expect(calls[2].options.sessionId).toBeUndefined();
  });

  it("does not strand later mutations behind a failed one", async () => {
    const { client, calls, answers } = fakeClient();
    answers.set("session.prepare", async () => {
      throw new BridgeError("timeout");
    });

    const commands = new NativeNavigationCommands(client, acknowledged());
    const failing = commands.start({});
    const settings = commands.updateSettings({ voiceEnabled: false });

    await expect(failing).rejects.toBeInstanceOf(CommandError);
    await settings;
    expect(calls.map((call) => call.type)).toContain("settings.update");
  });

  it("lets a snapshot request overtake a slow mutation", async () => {
    const { client, calls, answers } = fakeClient();
    const slow = deferred<unknown>();
    answers.set("session.prepare", () => slow.promise);

    const commands = new NativeNavigationCommands(client, acknowledged());
    void commands.start({}).catch(() => undefined);
    await commands.requestSnapshot();

    // A page that does not know where it stands is exactly the page that most
    // needs to ask.
    expect(calls.map((call) => call.type)).toContain("snapshot.request");
    slow.fail(new BridgeError("timeout"));
  });
});

describe("NativeNavigationCommands revision stamping", () => {
  it("stamps a mutation with the rendered session and revision", async () => {
    const { client, calls } = fakeClient();

    await new NativeNavigationCommands(client, acknowledged("s7", 12)).stop();

    expect(calls[0].options).toMatchObject({ sessionId: "s7", revision: 12 });
  });

  it("omits a stamp it does not have", async () => {
    const { client, calls } = fakeClient();

    await new NativeNavigationCommands(client, acknowledged(null, null)).updateSettings({
      voiceEnabled: true,
    });

    expect(calls[0].options.sessionId).toBeUndefined();
    expect(calls[0].options.revision).toBeUndefined();
  });

  it("sends arrival as its own command", async () => {
    const { client, calls } = fakeClient();

    await new NativeNavigationCommands(client, acknowledged()).stop(true);

    expect(calls[0].type).toBe("session.complete");
  });

  it("sends nothing when there is nothing to acknowledge", async () => {
    const { client, calls } = fakeClient();

    await new NativeNavigationCommands(client, acknowledged()).acknowledgeEvents([]);

    expect(calls).toEqual([]);
  });
});
