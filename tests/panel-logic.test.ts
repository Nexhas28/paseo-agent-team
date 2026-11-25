import { describe, expect, it } from "vitest";
import { blankOrchestratorModel, effortChoices, latestResult, proposalPollInterval, reservedByOtherTeam } from "../client/panel-logic";
import type { ProviderInfo } from "../shared/validate";

const provider = (id: string, ready: boolean, models: string[]): ProviderInfo => ({ id, ready, status: ready ? "ready" : "unavailable", models: models.map((model) => ({ id: model, label: model, efforts: [] })) });

describe("proposalPollInterval", () => {
  it("polls while there is no answer yet or the planner is running", () => {
    expect(proposalPollInterval({ status: "pending" })).toBe(2000);
    expect(proposalPollInterval({ status: "success", data: { status: "running" } })).toBe(2000);
  });

  it("stops when the proposal settles", () => {
    expect(proposalPollInterval({ status: "success", data: { status: "done" } })).toBe(false);
    expect(proposalPollInterval({ status: "success", data: { status: "failed" } })).toBe(false);
  });

  it("stops after a failed request, with or without an earlier answer", () => {
    expect(proposalPollInterval({ status: "error" })).toBe(false);
    expect(proposalPollInterval({ status: "error", data: { status: "running" } })).toBe(false);
  });
});

describe("blankOrchestratorModel", () => {
  it("prefers Claude when it is ready", () => {
    expect(blankOrchestratorModel([provider("codex", true, ["gpt"]), provider("claude", true, ["opus", "sonnet"])])).toEqual({ provider: "claude", model: "opus" });
  });

  it("falls back to the first ready provider when Claude is not ready or missing", () => {
    expect(blankOrchestratorModel([provider("claude", false, ["opus"]), provider("codex", true, ["gpt"])])).toEqual({ provider: "codex", model: "gpt" });
    expect(blankOrchestratorModel([provider("codex", true, ["gpt"])])).toEqual({ provider: "codex", model: "gpt" });
  });

  it("is empty when no provider is ready", () => {
    expect(blankOrchestratorModel([provider("claude", false, ["opus"])])).toEqual({ provider: "", model: "" });
  });
});

describe("effortChoices", () => {
  const efforts = [{ id: "low", label: "Low" }, { id: "high", label: "High" }];

  it("returns the model's efforts when the set effort is one of them or unset", () => {
    expect(effortChoices(efforts, "low")).toEqual(efforts);
    expect(effortChoices(efforts, undefined)).toEqual(efforts);
    expect(effortChoices([], undefined)).toEqual([]);
  });

  it("keeps an effort the model does not offer so the picker can clear it", () => {
    expect(effortChoices([], "high")).toEqual([{ id: "high", label: "high" }]);
    expect(effortChoices(efforts, "max")).toEqual([...efforts, { id: "max", label: "max" }]);
  });
});

describe("reservedByOtherTeam", () => {
  it("is true when the workspace has no team and another team reserves its title", () => {
    expect(reservedByOtherTeam("design", false, ["orchestrator", "design"])).toBe(true);
    expect(reservedByOtherTeam(" Design ", false, ["design"])).toBe(true);
  });

  it("is false with a team of its own, a free title, or a project target", () => {
    expect(reservedByOtherTeam("design", true, ["design"])).toBe(false);
    expect(reservedByOtherTeam("design", false, ["orchestrator"])).toBe(false);
    expect(reservedByOtherTeam(null, false, ["design"])).toBe(false);
  });
});

describe("latestResult", () => {
  it("returns the only result there is, or null", () => {
    expect(latestResult({ data: "applied", submittedAt: 1 }, { data: undefined, submittedAt: 0 })).toBe("applied");
    expect(latestResult({ data: undefined, submittedAt: 0 }, { data: "shared", submittedAt: 1 })).toBe("shared");
    expect(latestResult<string>({ data: undefined, submittedAt: 0 }, { data: undefined, submittedAt: 0 })).toBeNull();
  });

  it("returns the one submitted later", () => {
    expect(latestResult({ data: "applied", submittedAt: 5 }, { data: "shared", submittedAt: 9 })).toBe("shared");
    expect(latestResult({ data: "applied", submittedAt: 9 }, { data: "shared", submittedAt: 5 })).toBe("applied");
  });
});
