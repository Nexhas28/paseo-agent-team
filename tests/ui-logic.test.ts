import { describe, expect, it } from "vitest";
import { agentKind, agentMeta, agentStatusKey } from "../client/agent-label";
import { highlightTarget, matchOptions, rovingTarget, scrollToReveal, tabStop } from "../client/ui/logic";

describe("rovingTarget", () => {
  it("moves with the arrows and wraps at both ends", () => {
    expect(rovingTarget("ArrowRight", 0, 3)).toBe(1);
    expect(rovingTarget("ArrowRight", 2, 3)).toBe(0);
    expect(rovingTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(rovingTarget("ArrowLeft", 2, 3)).toBe(1);
  });

  it("goes to the ends with Home and End", () => {
    expect(rovingTarget("Home", 2, 4)).toBe(0);
    expect(rovingTarget("End", 1, 4)).toBe(3);
  });

  it("swaps left and right in a right-to-left layout", () => {
    expect(rovingTarget("ArrowLeft", 0, 3, { rtl: true })).toBe(1);
    expect(rovingTarget("ArrowRight", 0, 3, { rtl: true })).toBe(2);
  });

  it("uses up and down only when vertical", () => {
    expect(rovingTarget("ArrowDown", 0, 3)).toBeNull();
    expect(rovingTarget("ArrowDown", 0, 3, { vertical: true })).toBe(1);
    expect(rovingTarget("ArrowUp", 0, 3, { vertical: true })).toBe(2);
    expect(rovingTarget("ArrowRight", 0, 3, { vertical: true })).toBeNull();
  });

  it("skips disabled items, also for Home and End", () => {
    const disabled = [true, false, true, false];
    expect(rovingTarget("ArrowRight", 1, 4, { disabled })).toBe(3);
    expect(rovingTarget("ArrowRight", 3, 4, { disabled })).toBe(1);
    expect(rovingTarget("Home", 3, 4, { disabled })).toBe(1);
    expect(rovingTarget("End", 1, 4, { disabled: [false, false, true, true] })).toBe(1);
  });

  it("ignores other keys, an empty group and a group with nothing enabled", () => {
    expect(rovingTarget("Enter", 0, 3)).toBeNull();
    expect(rovingTarget("Tab", 0, 3)).toBeNull();
    expect(rovingTarget("ArrowRight", 0, 0)).toBeNull();
    expect(rovingTarget("ArrowRight", 0, 2, { disabled: [true, true] })).toBeNull();
  });
});

describe("tabStop", () => {
  it("is the selected item", () => {
    expect(tabStop(2, 3)).toBe(2);
  });

  it("falls back to the first enabled item when nothing usable is selected", () => {
    expect(tabStop(-1, 3)).toBe(0);
    expect(tabStop(5, 3)).toBe(0);
    expect(tabStop(0, 3, [true, false, false])).toBe(1);
    expect(tabStop(-1, 2, [true, true])).toBe(-1);
    expect(tabStop(-1, 0)).toBe(-1);
  });
});

describe("matchOptions", () => {
  const options = ["claude-opus", "Claude-Sonnet", "gpt-5"];

  it("returns every option for a blank query", () => {
    expect(matchOptions(options, "")).toEqual(options);
    expect(matchOptions(options, "   ")).toEqual(options);
  });

  it("matches anywhere in the text, ignoring case and outer spaces", () => {
    expect(matchOptions(options, " CLAUDE ")).toEqual(["claude-opus", "Claude-Sonnet"]);
    expect(matchOptions(options, "sonnet")).toEqual(["Claude-Sonnet"]);
    expect(matchOptions(options, "llama")).toEqual([]);
  });
});

describe("highlightTarget", () => {
  it("steps down and up without wrapping", () => {
    expect(highlightTarget("ArrowDown", 0, 3)).toBe(1);
    expect(highlightTarget("ArrowDown", 2, 3)).toBe(2);
    expect(highlightTarget("ArrowUp", 1, 3)).toBe(0);
    expect(highlightTarget("ArrowUp", 0, 3)).toBe(0);
  });

  it("starts from the last option when the list shrank under the highlight", () => {
    expect(highlightTarget("ArrowUp", 9, 3)).toBe(1);
    expect(highlightTarget("ArrowDown", 9, 3)).toBe(2);
  });

  it("ignores other keys and an empty list", () => {
    expect(highlightTarget("Enter", 0, 3)).toBeNull();
    expect(highlightTarget("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("scrollToReveal", () => {
  it("stays put when the row is in view", () => {
    expect(scrollToReveal({ y: 40, height: 36 }, 0, 320)).toBeNull();
    expect(scrollToReveal({ y: 284, height: 36 }, 0, 320)).toBeNull();
  });

  it("scrolls up to a row above the view and down just enough for one below", () => {
    expect(scrollToReveal({ y: 40, height: 36 }, 100, 320)).toBe(40);
    expect(scrollToReveal({ y: 400, height: 36 }, 0, 320)).toBe(116);
  });
});

describe("agentStatusKey", () => {
  const node = { waiting: false, badge: null, live: false, delegating: false } as const;

  it("names each status a card shows", () => {
    expect(agentStatusKey(node)).toBe("statusIdle");
    expect(agentStatusKey({ ...node, live: true, badge: "running" })).toBe("statusRunning");
    expect(agentStatusKey({ ...node, delegating: true })).toBe("statusDelegating");
    expect(agentStatusKey({ ...node, badge: "done" })).toBe("statusDone");
    expect(agentStatusKey({ ...node, badge: "attention" })).toBe("statusError");
    expect(agentStatusKey({ ...node, badge: "question" })).toBe("statusAwaiting");
    expect(agentStatusKey({ ...node, waiting: true })).toBe("waiting");
  });

  it("puts what needs the user before activity", () => {
    expect(agentStatusKey({ ...node, badge: "question", delegating: true })).toBe("statusAwaiting");
    expect(agentStatusKey({ ...node, badge: "attention", delegating: true })).toBe("statusError");
    expect(agentStatusKey({ ...node, badge: "done", delegating: true })).toBe("statusDelegating");
  });
});

describe("agentKind", () => {
  const agent = { provider: "codex" };

  it("uses the team kind, then the role, then the provider", () => {
    expect(agentKind({ kind: "orchestrator", role: null, agent })).toEqual({ key: "kindOrchestrator" });
    expect(agentKind({ kind: "planner", role: null, agent })).toEqual({ key: "kindPlanner" });
    expect(agentKind({ kind: "subagent", role: null, agent })).toEqual({ key: "subagent" });
    expect(agentKind({ kind: "role", role: "ui", agent })).toEqual({ key: "kindRole", role: "ui" });
    expect(agentKind({ kind: "agent", role: null, agent })).toEqual({ provider: "codex" });
  });
});

describe("agentMeta", () => {
  it("joins what is set", () => {
    expect(agentMeta({ model: "opus", effort: "high", mode: "auto" })).toBe("opus · high · auto");
    expect(agentMeta({ model: "opus", effort: null, mode: null })).toBe("opus");
    expect(agentMeta({ model: null, effort: null, mode: null })).toBe("");
  });
});
