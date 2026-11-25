import { describe, expect, it } from "vitest";
import { noticesOf, outcomeToken, pendingPickup, pollPhase } from "../client/panel-logic";
import { announcementKey, rovingTabIndex } from "../client/ui/logic";

describe("rovingTabIndex (V2)", () => {
  it("gives the web one tab stop", () => {
    expect([0, 1, 2].map((index) => rovingTabIndex(index, 1, true))).toEqual([-1, 0, -1]);
  });

  it("leaves every item reachable where arrow keys are not handled", () => {
    expect([0, 1, 2].map((index) => rovingTabIndex(index, 1, false))).toEqual([undefined, undefined, undefined]);
  });
});

describe("announcementKey (V4)", () => {
  it("is the same for the same text and token, so nothing is announced twice", () => {
    expect(announcementKey("Applied: team.json", 1)).toBe(announcementKey("Applied: team.json", 1));
  });

  it("differs when the same text comes from a new outcome", () => {
    expect(announcementKey("Applied: team.json", 2)).not.toBe(announcementKey("Applied: team.json", 1));
  });

  it("differs when the text changes without a token", () => {
    expect(announcementKey("a", undefined)).not.toBe(announcementKey("b", undefined));
  });

  it("is empty for empty text whatever the token, so a cleared region announces nothing", () => {
    expect(announcementKey("", 1)).toBe("");
    expect(announcementKey("", 2)).toBe("");
  });
});

describe("outcomeToken (V4)", () => {
  it("is the latest submission among settled mutations", () => {
    expect(outcomeToken([{ status: "success", submittedAt: 10 }, { status: "error", submittedAt: 30 }, { status: "idle", submittedAt: 0 }])).toBe(30);
  });

  it("ignores a mutation that is still running, so starting an action does not re-announce the old result", () => {
    expect(outcomeToken([{ status: "success", submittedAt: 10 }, { status: "pending", submittedAt: 40 }])).toBe(10);
  });

  it("changes when the same action settles again", () => {
    expect(outcomeToken([{ status: "success", submittedAt: 10 }])).not.toBe(outcomeToken([{ status: "success", submittedAt: 20 }]));
  });

  it("is 0 with nothing settled", () => {
    expect(outcomeToken([])).toBe(0);
    expect(outcomeToken([{ status: "idle", submittedAt: 0 }])).toBe(0);
  });
});

describe("pollPhase (R9)", () => {
  it("is idle with no planner tracked", () => {
    expect(pollPhase(null, { isError: false })).toBe("idle");
    expect(pollPhase(null, { isError: true })).toBe("idle");
  });

  it("waits until the first answer and while the planner runs", () => {
    expect(pollPhase("a", { isError: false })).toBe("waiting");
    expect(pollPhase("a", { isError: false, data: { status: "running" } })).toBe("waiting");
  });

  it("is errored, not waiting, once a poll failed before the planner settled", () => {
    expect(pollPhase("a", { isError: true })).toBe("errored");
    expect(pollPhase("a", { isError: true, data: { status: "running" } })).toBe("errored");
  });

  it("is idle once the planner answered", () => {
    expect(pollPhase("a", { isError: false, data: { status: "done" } })).toBe("idle");
    expect(pollPhase("a", { isError: false, data: { status: "failed" } })).toBe("idle");
    expect(pollPhase("a", { isError: true, data: { status: "done" } })).toBe("idle");
  });
});

describe("pendingPickup (S7)", () => {
  const free = { hasTeam: false, drafting: false, starting: false, sharing: false };

  it("picks the leftover planner up when nothing else is going on", () => {
    expect(pendingPickup("agent-1", free)).toBe("agent-1");
  });

  it("has nothing to pick up without a leftover planner", () => {
    expect(pendingPickup(null, free)).toBeNull();
    expect(pendingPickup(undefined, free)).toBeNull();
    expect(pendingPickup("", free)).toBeNull();
  });

  it.each(["hasTeam", "drafting", "starting", "sharing"] as const)("does not pick it up while %s", (flag) => {
    expect(pendingPickup("agent-1", { ...free, [flag]: true })).toBeNull();
  });
});

describe("noticesOf (V1)", () => {
  it("returns the advisory lines of a result", () => {
    expect(noticesOf({ ok: true, cleanup: [], notices: ["orchestrator X in W still runs on claude/opus; use Reset session in W"] })).toEqual(["orchestrator X in W still runs on claude/opus; use Reset session in W"]);
  });

  it("is empty for a result from a daemon that sends none, and for no result", () => {
    expect(noticesOf({ ok: true, cleanup: ["planner"] })).toEqual([]);
    expect(noticesOf(null)).toEqual([]);
    expect(noticesOf(undefined)).toEqual([]);
  });

  it("drops anything that is not a line of text", () => {
    expect(noticesOf({ notices: "one" })).toEqual([]);
    expect(noticesOf({ notices: ["a", 1, null, "b"] })).toEqual(["a", "b"]);
  });
});
