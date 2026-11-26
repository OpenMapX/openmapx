import { attentionUpsertStatement } from "@openmapx/core/attention";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";
import { acknowledgeAttention, listAttention, raiseAttention, resolveAttention } from "./attention";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

dbDescribe("stored attention list", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
  }, 90_000);
  afterAll(async () => {
    await fixture?.stop();
  });
  beforeEach(async () => {
    await fixture.sql`DELETE FROM attention_notification`;
    await fixture.sql`DELETE FROM attention_item`;
  });

  it("keeps one row per key, replaces its text and keeps when it was first raised", async () => {
    const base = { key: "extensions.revoked:demo", source: "extensions" } as const;
    expect(
      await raiseAttention(
        { ...base, severity: "warning", title: "Demo was delisted" },
        fixture.db,
      ),
    ).toBe("inserted");
    const [first] = await listAttention(fixture.db);
    expect(first).toMatchObject({ clearance: "condition", acknowledgedAt: null });
    expect(
      await raiseAttention(
        {
          ...base,
          severity: "critical",
          title: "Demo was disabled",
          detail: "A critical advisory covers version 1.0.0.",
          action: { label: "Open", href: "/admin/extensions/demo" },
        },
        fixture.db,
      ),
    ).toBe("escalated");
    const outcomes = await Promise.all(
      [1, 2, 3].map(() =>
        raiseAttention({ ...base, severity: "critical", title: "Demo was disabled" }, fixture.db),
      ),
    );
    expect(outcomes.sort()).toEqual(["changed", "unchanged", "unchanged"]);
    const items = await listAttention(fixture.db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: base.key,
      severity: "critical",
      title: "Demo was disabled",
      detail: null,
      action: null,
      raisedAt: first?.raisedAt,
    });
  });

  it("writes nothing when a raise changes nothing", async () => {
    const input = {
      key: "same.text",
      severity: "warning",
      source: "test",
      title: "Same",
      detail: "Detail",
    } as const;
    // Microseconds, which the listed millisecond timestamps would hide.
    const storedUpdatedAt = async () =>
      (
        await fixture.sql<{ at: string }[]>`
          SELECT updated_at::text AS at FROM attention_item WHERE key = ${input.key}`
      )[0]?.at;
    await raiseAttention(input, fixture.db);
    const [before] = (await listAttention(fixture.db)).filter((item) => item.key === input.key);
    const storedBefore = await storedUpdatedAt();
    expect(await raiseAttention(input, fixture.db)).toBe("unchanged");
    const [after] = (await listAttention(fixture.db)).filter((item) => item.key === input.key);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(await storedUpdatedAt()).toBe(storedBefore);
    expect(await raiseAttention({ ...input, detail: "Other detail" }, fixture.db)).toBe("changed");
    expect(await storedUpdatedAt()).not.toBe(storedBefore);
    expect(
      await raiseAttention({ ...input, severity: "info", detail: "Other detail" }, fixture.db),
    ).toBe("changed");
  });

  it("keeps an acknowledged condition item listed and quiet until it escalates", async () => {
    const disk = {
      key: "storage-low:data",
      severity: "warning",
      source: "operations",
      title: "Disk space low (data)",
    } as const;
    await raiseAttention(disk, fixture.db);
    await raiseAttention(
      {
        key: "storage-low:state",
        severity: "warning",
        source: "operations",
        title: "Disk space low (state)",
      },
      fixture.db,
    );
    await fixture.sql`INSERT INTO attention_notification (attention_key, occurrence, channel, severity, due_at)
      VALUES (${disk.key}, 'o1', 'email', 'warning', now()), (${disk.key}, 'o1', 'webhook', 'warning', now())`;
    await fixture.sql`UPDATE attention_notification SET status = 'sent', sent_at = now() WHERE channel = 'webhook'`;
    expect(await acknowledgeAttention(disk.key, fixture.db)).toBe(true);
    expect(await acknowledgeAttention("never.raised", fixture.db)).toBe(false);
    expect(
      await fixture.sql`SELECT channel, status FROM attention_notification WHERE attention_key = ${disk.key} ORDER BY 1`,
    ).toEqual([
      { channel: "email", status: "canceled" },
      { channel: "webhook", status: "sent" },
    ]);
    const keys = (await listAttention(fixture.db)).map((item) => item.key);
    expect(keys.indexOf("storage-low:state")).toBeLessThan(keys.indexOf(disk.key));
    expect(
      await raiseAttention({ ...disk, title: "Disk space still low (data)" }, fixture.db),
    ).toBe("unchanged");
    const [muted] = (await listAttention(fixture.db)).filter((item) => item.key === disk.key);
    expect(muted).toMatchObject({
      title: disk.title,
      clearance: "condition",
      acknowledgedAt: expect.any(String),
    });
    expect(await raiseAttention({ ...disk, severity: "critical" }, fixture.db)).toBe("escalated");
    const [escalated] = (await listAttention(fixture.db)).filter((item) => item.key === disk.key);
    expect(escalated).toMatchObject({
      severity: "critical",
      acknowledgedAt: null,
      raisedAt: muted?.raisedAt,
    });
  });

  it("hides an acknowledged acknowledge item until a new occurrence", async () => {
    const job = {
      key: "job-failed:application:service.restart",
      severity: "warning",
      source: "operations",
      title: "Restart failed",
      clearance: "acknowledge",
    } as const;
    expect(await raiseAttention({ ...job, occurrenceRef: "job-1" }, fixture.db)).toBe("inserted");
    const [first] = (await listAttention(fixture.db)).filter((item) => item.key === job.key);
    expect(first).toMatchObject({ clearance: "acknowledge", acknowledgedAt: null });
    expect(await acknowledgeAttention(job.key, fixture.db)).toBe(true);
    expect((await listAttention(fixture.db)).map((item) => item.key)).not.toContain(job.key);
    expect(
      await raiseAttention(
        { ...job, occurrenceRef: "job-1", title: "Restart failed again" },
        fixture.db,
      ),
    ).toBe("unchanged");
    expect(await raiseAttention({ ...job, occurrenceRef: "job-2" }, fixture.db)).toBe("inserted");
    const [second] = (await listAttention(fixture.db)).filter((item) => item.key === job.key);
    expect(second?.acknowledgedAt).toBeNull();
    expect(Date.parse(second?.raisedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(first?.raisedAt ?? ""),
    );
  });

  it("lets the host write an item with the statement alone", async () => {
    const { text, values } = attentionUpsertStatement({
      key: "host.written",
      severity: "critical",
      source: "updates",
      title: "Update incomplete",
    });
    expect(await fixture.sql.unsafe(text, values)).toEqual([{ outcome: "inserted" }]);
    expect(await fixture.sql.unsafe(text, values)).toEqual([{ outcome: "unchanged" }]);
    expect((await listAttention(fixture.db)).map((item) => item.key)).toContain("host.written");
  });

  it("writes the same row through a plain SQL client as through the service", async () => {
    const input = {
      severity: "warning",
      source: "operations",
      title: "Restart failed",
      detail: "The service did not come back.",
      action: { label: "Open", href: "/admin/activity" },
      clearance: "acknowledge",
      occurrenceRef: "job-7",
    } as const;
    await raiseAttention({ ...input, key: "written.by-service" }, fixture.db);
    const { text, values } = attentionUpsertStatement({ ...input, key: "written.by-host" });
    await fixture.sql.unsafe(text, values);
    const rows = await fixture.sql`
      SELECT key, severity, source, title, detail, action, clearance, occurrence_ref, acknowledged_at
      FROM attention_item WHERE key IN ('written.by-service', 'written.by-host') ORDER BY key`;
    expect(rows).toHaveLength(2);
    const [byHost, byService] = rows;
    expect({ ...byHost, key: null }).toEqual({ ...byService, key: null });
  });

  it("lists critical items first and forgets a resolved one", async () => {
    await raiseAttention(
      { key: "a.info", severity: "info", source: "test", title: "Info" },
      fixture.db,
    );
    await raiseAttention(
      { key: "b.critical", severity: "critical", source: "test", title: "Critical" },
      fixture.db,
    );
    await raiseAttention(
      { key: "c.warning", severity: "warning", source: "test", title: "Warning" },
      fixture.db,
    );
    const keys = (await listAttention(fixture.db)).map((item) => item.key);
    expect(keys.indexOf("b.critical")).toBeLessThan(keys.indexOf("c.warning"));
    expect(keys.indexOf("c.warning")).toBeLessThan(keys.indexOf("a.info"));
    await resolveAttention("b.critical", fixture.db);
    await resolveAttention("never.raised", fixture.db);
    expect((await listAttention(fixture.db)).map((item) => item.key)).not.toContain("b.critical");
  });

  it("stores an item whose text is too long, shortened", async () => {
    await raiseAttention(
      {
        key: "long.text",
        severity: "warning",
        source: "test",
        title: "T".repeat(500),
        detail: "D".repeat(5_000),
      },
      fixture.db,
    );
    const item = (await listAttention(fixture.db)).find((entry) => entry.key === "long.text");
    expect(item?.title).toHaveLength(200);
    expect(item?.title.endsWith("…")).toBe(true);
    expect(item?.detail).toHaveLength(2_000);
    expect(item?.detail?.endsWith("…")).toBe(true);
  });

  it("refuses an item it could not show safely", async () => {
    await expect(
      raiseAttention(
        {
          key: "x",
          severity: "info",
          source: "test",
          title: "T",
          action: { label: "Open", href: "https://example.org/" },
        },
        fixture.db,
      ),
    ).rejects.toThrow();
    await expect(
      raiseAttention({ key: "x", severity: "info", source: "test", title: "" }, fixture.db),
    ).rejects.toThrow();
    await expect(
      raiseAttention(
        { key: "Has Spaces", severity: "info", source: "test", title: "T" },
        fixture.db,
      ),
    ).rejects.toThrow();
    await expect(
      raiseAttention(
        { key: "x", severity: "info", source: "test", title: "T", occurrenceRef: "r".repeat(129) },
        fixture.db,
      ),
    ).rejects.toThrow();
  });
});
