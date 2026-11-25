import { describe, expect, it } from "vitest";
import { agentKind, agentMeta, agentStatusKey, type AgentKindLabel, type AgentStatusKey } from "../client/agent-label";
import { blankOrchestratorModel, proposalPollInterval } from "../client/panel-logic";
import { highlightTarget, matchOptions, rovingTarget, tabStop } from "../client/ui/logic";
import { en, ja, ko, zh } from "../shared/messages";

describe("rovingTarget: edges", () => {
  it("stays on the only item of a single-item group", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) expect(rovingTarget(key, 0, 1)).toBe(0);
    expect(rovingTarget("ArrowDown", 0, 1, { vertical: true })).toBe(0);
    expect(rovingTarget("ArrowUp", 0, 1, { vertical: true })).toBe(0);
  });

  it("returns null for every key on an empty group", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) expect(rovingTarget(key, 0, 0, { vertical: true })).toBeNull();
  });

  it("wraps from either end in vertical and right-to-left groups", () => {
    expect(rovingTarget("ArrowDown", 2, 3, { vertical: true })).toBe(0);
    expect(rovingTarget("ArrowUp", 0, 3, { vertical: true })).toBe(2);
    expect(rovingTarget("ArrowLeft", 2, 3, { rtl: true })).toBe(0);
    expect(rovingTarget("ArrowRight", 0, 3, { rtl: true })).toBe(2);
  });

  it("ignores rtl for vertical groups", () => {
    expect(rovingTarget("ArrowDown", 0, 3, { vertical: true, rtl: true })).toBe(1);
    expect(rovingTarget("ArrowUp", 1, 3, { vertical: true, rtl: true })).toBe(0);
  });

  it("is case sensitive about keys and ignores modifier-like names", () => {
    expect(rovingTarget("home", 2, 4)).toBeNull();
    expect(rovingTarget("Shift", 2, 4)).toBeNull();
    expect(rovingTarget("", 2, 4)).toBeNull();
  });

  it("returns null for Home and End when every item is disabled", () => {
    expect(rovingTarget("Home", 0, 2, { disabled: [true, true] })).toBeNull();
    expect(rovingTarget("End", 0, 2, { disabled: [true, true] })).toBeNull();
  });

  it("moves to the same item when it is the only enabled one", () => {
    expect(rovingTarget("ArrowRight", 1, 3, { disabled: [true, false, true] })).toBe(1);
    expect(rovingTarget("ArrowLeft", 1, 3, { disabled: [true, false, true] })).toBe(1);
  });

  it("copes with an index outside the group", () => {
    expect(rovingTarget("ArrowRight", -1, 3)).toBe(0);
    expect(rovingTarget("ArrowLeft", 3, 3)).toBe(2);
    expect(rovingTarget("ArrowRight", 7, 3)).toBe(2);
  });
});

describe("tabStop: edges", () => {
  it("takes the selected item even when it is the last", () => {
    expect(tabStop(2, 3, [false, false, false])).toBe(2);
  });

  it("falls back to the first enabled item when the selected one is disabled", () => {
    expect(tabStop(1, 3, [false, true, false])).toBe(0);
    expect(tabStop(0, 3, [true, true, false])).toBe(2);
  });

  it("handles a single item, enabled or not", () => {
    expect(tabStop(0, 1)).toBe(0);
    expect(tabStop(-1, 1)).toBe(0);
    expect(tabStop(0, 1, [true])).toBe(-1);
  });

  it("is the same item the roving keys leave from, so exactly one item takes Tab", () => {
    const disabled = [true, false, false];
    const stop = tabStop(-1, 3, disabled);
    expect(stop).toBe(1);
    expect(rovingTarget("Home", stop, 3, { disabled })).toBe(stop);
  });
});

describe("matchOptions: edges", () => {
  it("returns a copy, not the input array", () => {
    const options = ["a", "b"];
    expect(matchOptions(options, "")).not.toBe(options);
  });

  it("returns nothing for no options, with or without a query", () => {
    expect(matchOptions([], "")).toEqual([]);
    expect(matchOptions([], "x")).toEqual([]);
  });

  it("keeps the original order and casing, and treats the query as plain text", () => {
    expect(matchOptions(["B-Model", "a-model", "c"], "MODEL")).toEqual(["B-Model", "a-model"]);
    expect(matchOptions(["a.b", "axb"], ".")).toEqual(["a.b"]);
    expect(matchOptions(["(x)", "x"], "(")).toEqual(["(x)"]);
  });

  it("does not trim inner spaces", () => {
    expect(matchOptions(["claude opus", "claude-opus"], "claude opus")).toEqual(["claude opus"]);
  });

  it("matches non-latin text", () => {
    expect(matchOptions(["모델 하나", "모델 둘", "other"], "하나")).toEqual(["모델 하나"]);
  });
});

describe("highlightTarget: edges", () => {
  it("stays on the only option", () => {
    expect(highlightTarget("ArrowDown", 0, 1)).toBe(0);
    expect(highlightTarget("ArrowUp", 0, 1)).toBe(0);
  });

  it("returns null when there are no matches, for either arrow", () => {
    expect(highlightTarget("ArrowDown", 0, 0)).toBeNull();
    expect(highlightTarget("ArrowUp", 3, 0)).toBeNull();
    expect(highlightTarget("ArrowDown", 0, -1)).toBeNull();
  });

  it("starts from the first option for a negative highlight", () => {
    expect(highlightTarget("ArrowDown", -5, 3)).toBe(1);
    expect(highlightTarget("ArrowUp", -5, 3)).toBe(0);
  });

  it("does not wrap and does not claim Home, End or Enter", () => {
    expect(highlightTarget("ArrowDown", 2, 3)).toBe(2);
    expect(highlightTarget("ArrowUp", 0, 3)).toBe(0);
    for (const key of ["Home", "End", "Enter", "ArrowLeft", "ArrowRight"]) expect(highlightTarget(key, 1, 3)).toBeNull();
  });

  it("works on a list narrowed by the query", () => {
    const shown = matchOptions(["alpha", "beta", "alphabet"], "alpha");
    expect(shown).toEqual(["alpha", "alphabet"]);
    expect(highlightTarget("ArrowDown", 0, shown.length)).toBe(1);
    expect(highlightTarget("ArrowDown", 1, shown.length)).toBe(1);
    expect(highlightTarget("ArrowDown", 0, matchOptions(["alpha"], "zzz").length)).toBeNull();
  });
});

/** Mirrors what t() does with the message resources: nested keys, _one/_other plurals and {{placeholders}}. */
function translator(resource: object, language: string) {
  const plural = new Intl.PluralRules(language);
  const find = (key: string): unknown => key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), resource);
  return (key: string, params: Record<string, string | number> = {}): string => {
    const text = (typeof params.count === "number" ? find(`${key}_${plural.select(params.count)}`) : undefined) ?? find(key);
    if (typeof text !== "string") throw new Error(`missing message ${key} in ${language}`);
    return text.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => {
      if (!(name in params)) throw new Error(`${key} in ${language} needs {{${name}}}`);
      return String(params[name]);
    });
  };
}

/** The same composition AgentDashboard's agentLabel does. */
function composeLabel(t: ReturnType<typeof translator>, node: { title: string; kind: Parameters<typeof agentKind>[0]["kind"]; role: string | null; provider: string; model: string | null; waiting?: boolean; badge?: "question" | "attention" | "running" | "done" | null; live?: boolean; delegating?: boolean }): string {
  const kind: AgentKindLabel = agentKind({ kind: node.kind, role: node.role, agent: { provider: node.provider } });
  const parts = {
    title: node.title,
    kind: "provider" in kind ? kind.provider : kind.key === "kindRole" ? t("kindRole", { role: kind.role }) : t(kind.key),
    status: t(agentStatusKey({ waiting: node.waiting ?? false, badge: node.badge ?? null, live: node.live ?? false, delegating: node.delegating ?? false })),
  };
  const model = agentMeta({ model: node.model, effort: null, mode: null });
  return model ? t("agentLabelWithModel", { ...parts, model }) : t("agentLabel", parts);
}

const languages = [["en", en], ["ko", ko], ["ja", ja], ["zh", zh]] as const;

describe("agent card label across status and kind", () => {
  const statuses: { status: AgentStatusKey; node: { waiting?: boolean; badge?: "question" | "attention" | "running" | "done" | null; live?: boolean; delegating?: boolean } }[] = [
    { status: "waiting", node: { waiting: true } },
    { status: "statusAwaiting", node: { badge: "question" } },
    { status: "statusError", node: { badge: "attention" } },
    { status: "statusRunning", node: { live: true } },
    { status: "statusDelegating", node: { delegating: true } },
    { status: "statusDone", node: { badge: "done" } },
    { status: "statusIdle", node: {} },
  ];
  const kinds = [
    { kind: "orchestrator" as const, role: null },
    { kind: "planner" as const, role: null },
    { kind: "subagent" as const, role: null },
    { kind: "role" as const, role: "ui" },
    { kind: "agent" as const, role: null },
  ];

  it("names every status key with a message in English", () => {
    const t = translator(en, "en");
    for (const { status } of statuses) expect(t(status).length).toBeGreaterThan(0);
  });

  it("builds the English label for each status and kind, with and without a model", () => {
    const t = translator(en, "en");
    expect(composeLabel(t, { title: "Dash", kind: "orchestrator", role: null, provider: "claude", model: null })).toBe("Dash, Orchestrator, idle");
    expect(composeLabel(t, { title: "Dash", kind: "orchestrator", role: null, provider: "claude", model: "opus" })).toBe("Dash, Orchestrator, idle, opus");
    expect(composeLabel(t, { title: "Plan", kind: "planner", role: null, provider: "claude", model: null, live: true })).toBe("Plan, Planner, running");
    expect(composeLabel(t, { title: "Ui", kind: "role", role: "ui", provider: "codex", model: "gpt" })).toBe("Ui, Role ui, idle, gpt");
    expect(composeLabel(t, { title: "Free", kind: "agent", role: null, provider: "codex", model: null, badge: "done" })).toBe("Free, codex, done");
    expect(composeLabel(t, { title: "Sub", kind: "subagent", role: null, provider: "claude", model: null, delegating: true })).toBe("Sub, Sub-agent, delegating");
    expect(composeLabel(t, { title: "Q", kind: "role", role: "qa", provider: "claude", model: null, badge: "question" })).toBe("Q, Role qa, waiting for your answer");
  });

  for (const [language, resource] of languages) {
    it(`composes a complete label for every status and kind in ${language}, with no placeholder left`, () => {
      const t = translator(resource, language);
      for (const { node } of statuses) {
        for (const kind of kinds) {
          for (const model of [null, "opus 4"]) {
            const label = composeLabel(t, { title: "Agent Title", ...kind, provider: "codex", model, ...node });
            expect(label).toContain("Agent Title");
            expect(label).not.toMatch(/{{|}}/);
            if (model) expect(label).toContain("opus 4");
          }
        }
      }
    });

    it(`labels each status distinctly in ${language}`, () => {
      const t = translator(resource, language);
      const keys: AgentStatusKey[] = ["waiting", "statusAwaiting", "statusError", "statusRunning", "statusDelegating", "statusDone", "statusIdle"];
      expect(new Set(keys.map((key) => t(key))).size).toBe(keys.length);
    });

    it(`has the remaining accessible-name messages in ${language}`, () => {
      const t = translator(resource, language);
      expect(t("hideAgentNamed", { agent: "Alpha" })).toContain("Alpha");
      expect(t("archiveAgentNamed", { agent: "Alpha" })).toContain("Alpha");
      expect(t("picker.resultCount", { count: 1 })).toContain("1");
      expect(t("picker.resultCount", { count: 5 })).toContain("5");
      expect(t("screen.openTeamNamed", { workspace: "main" })).toContain("main");
      expect(t("screen.newTeamNamed", { project: "proj" })).toContain("proj");
      expect(t("screen.tabsLabel").length).toBeGreaterThan(0);
      expect(t("screen.filterLabel").length).toBeGreaterThan(0);
    });
  }

  it("uses the singular and plural result count in English", () => {
    const t = translator(en, "en");
    expect(t("picker.resultCount", { count: 1 })).toBe("1 option");
    expect(t("picker.resultCount", { count: 0 })).toBe("0 options");
    expect(t("picker.resultCount", { count: 12 })).toBe("12 options");
  });
});

describe("poll interval and blank orchestrator: edges", () => {
  it("stops polling on an error even when the last answer was still running", () => {
    expect(proposalPollInterval({ status: "error", data: { status: "running" } })).toBe(false);
  });

  it("keeps polling while the first request is loading and no data has arrived", () => {
    expect(proposalPollInterval({ status: "pending" })).toBe(2000);
    expect(proposalPollInterval({ status: "loading" })).toBe(2000);
  });

  it("stops for any answer that is not running", () => {
    expect(proposalPollInterval({ status: "success", data: { status: "done" } })).toBe(false);
    expect(proposalPollInterval({ status: "success", data: { status: "none" } })).toBe(false);
  });

  it("picks nothing for an empty catalog and skips a ready provider that lists no models", () => {
    expect(blankOrchestratorModel([])).toEqual({ provider: "", model: "" });
    expect(blankOrchestratorModel([{ id: "codex", ready: true, status: "ready", models: [] }])).toEqual({ provider: "codex", model: "" });
  });

  it("takes the first model of the first ready provider when Claude is absent", () => {
    const entry = (id: string, ready: boolean, model: string) => ({ id, ready, status: ready ? "ready" : "unavailable", models: [{ id: model, label: model, efforts: [] }] });
    expect(blankOrchestratorModel([entry("a", false, "a1"), entry("b", true, "b1"), entry("c", true, "c1")])).toEqual({ provider: "b", model: "b1" });
  });
});
