import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restartOrchestrator } from "../server/team";
import { findOrchestrator, type OrchestratorCandidate } from "../shared/cleanup";
import { orchestratorPrompt, teamChangedMessage } from "../shared/prompt";
import { plannerPrompt, teamEditPrompt } from "../shared/proposal";
import { parseTeam, serializeTeam, TeamSchema, type Team } from "../shared/team";
import { applyTeamEdit, summarizeTeamEdit } from "../shared/team-edit";
import { TEAMS_DIR } from "../shared/team-files";
import { catalogFrom, validateTeam, type ProviderEntry } from "../shared/validate";

const options = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }];
const entries: ProviderEntry[] = [
  { provider: "claude", enabled: true, status: "ready", modes: [{ id: "auto" }], models: [{ id: "opus", label: "Opus", thinkingOptions: options, defaultThinkingOptionId: "medium" }, { id: "plain", label: "Plain" }] },
  { provider: "codex", enabled: true, status: "ready", modes: [{ id: "auto" }], models: [{ id: "sol", label: "Sol", thinkingOptions: [{ id: "low", label: "Low" }, { id: "xhigh", label: "XHigh" }] }] },
];
const catalog = catalogFrom(entries);

const team = (over: { orchestrator?: Partial<Team["orchestrator"]>; roles?: Team["roles"] } = {}): Team => ({
  version: 1,
  goal: "Ship it",
  orchestrator: { workspace: "lead", provider: "claude", model: "opus", ...over.orchestrator },
  roles: over.roles ?? [
    { name: "design", provider: "codex", model: "sol", effort: "xhigh", folders: ["src"], instructions: "Designs." },
    { name: "qa", provider: "claude", model: "opus", folders: [], instructions: "Tests." },
  ],
});

describe("effort schema", () => {
  it("effort is trimmed, and an empty effort becomes undefined so a saved file has no effort key", () => {
    const parsed = TeamSchema.parse({
      version: 1,
      goal: "",
      orchestrator: { workspace: "lead", provider: "claude", model: "opus", effort: "  high  " },
      roles: [
        { name: "a", provider: "claude", model: "opus", effort: "  low ", folders: [], instructions: "" },
        { name: "b", provider: "claude", model: "opus", effort: "   ", folders: [], instructions: "" },
        { name: "c", provider: "claude", model: "opus", effort: "", folders: [], instructions: "" },
        { name: "d", provider: "claude", model: "opus", folders: [], instructions: "" },
      ],
    });
    expect(parsed.orchestrator.effort).toBe("high");
    expect(parsed.roles.map((role) => role.effort)).toEqual(["low", undefined, undefined, undefined]);
    const text = serializeTeam(parsed);
    const saved = JSON.parse(text);
    expect(saved.roles[0].effort).toBe("low");
    for (const role of saved.roles.slice(1)) expect("effort" in role).toBe(false);
    expect(parseTeam(text)).toMatchObject({ ok: true });
  });

  it("effort is optional: a file without it parses as before", () => {
    const parsed = parseTeam(JSON.stringify(team({ roles: [{ name: "qa", provider: "claude", model: "opus", folders: [], instructions: "" }] })));
    expect(parsed.ok && parsed.team.orchestrator.effort).toBeUndefined();
  });
});

describe("effort catalog and validation", () => {
  it("effort options and the default are exposed by catalogFrom, empty when the model has none", () => {
    const claude = catalog.find((entry) => entry.id === "claude")!;
    expect(claude.models[0]).toEqual({ id: "opus", label: "Opus", efforts: options, defaultEffort: "medium" });
    expect(claude.models[1]).toEqual({ id: "plain", label: "Plain", efforts: [] });
    expect("defaultEffort" in claude.models[1]!).toBe(false);
  });

  it("effort that is not among the model's thinking options is reported for a role", () => {
    const problems = validateTeam(team({ roles: [{ name: "design", provider: "codex", model: "sol", effort: "high", folders: [], instructions: "" }] }), catalog);
    expect(problems).toEqual([{ target: "design", message: expect.stringContaining('effort "high" is not available for codex/sol (allowed: low, xhigh)') }]);
  });

  it("effort that is not among the model's thinking options is reported for the orchestrator", () => {
    const problems = validateTeam(team({ orchestrator: { effort: "xhigh" } }), catalog);
    expect(problems).toEqual([{ target: "orchestrator", message: expect.stringContaining('effort "xhigh" is not available for claude/opus (allowed: low, medium, high)') }]);
  });

  it("effort is reported as unsupported for a model without effort options", () => {
    const problems = validateTeam(team({ roles: [{ name: "qa", provider: "claude", model: "plain", effort: "low", folders: [], instructions: "" }] }), catalog);
    expect(problems[0]!.message).toContain("it has no effort options; leave it empty");
  });

  it("effort that is valid or missing passes validation", () => {
    expect(validateTeam(team({ orchestrator: { effort: "high" } }), catalog)).toEqual([]);
    expect(validateTeam(team(), catalog)).toEqual([]);
  });
});

describe("effort in the orchestrator prompt", () => {
  const modes = { design: "auto", qa: "auto" };
  const file = ".agents/teams/lead.json";

  it("effort is shown in the table, default when a role has none", () => {
    for (const text of [orchestratorPrompt(team(), modes, file), teamChangedMessage(team(), modes, file)]) {
      expect(text).toContain("| Role | Provider/model | Mode | Effort | Folders |");
      expect(text).toContain("| design | codex/sol | auto | xhigh | src |");
      expect(text).toContain("| qa | claude/opus | auto | default | (any) |");
    }
  });

  it("effort is passed with --thinking or settings.thinkingOptionId, and omitted for default", () => {
    const prompt = orchestratorPrompt(team(), modes, file);
    expect(prompt).toContain("--thinking <effort>");
    expect(prompt).toContain("settings.thinkingOptionId with Paseo tools, and omit it when the Effort is `default`");
    expect(teamChangedMessage(team(), modes, file)).toContain("`--thinking <effort>` with `paseo run`, settings.thinkingOptionId with Paseo tools; omit it when the Effort is `default`");
    const withFeatures = orchestratorPrompt(team(), modes, file, { design: { auto_accept: true } });
    expect(withFeatures).toContain("Set settings.thinkingOptionId to the role's Effort; omit it when the Effort is `default`.");
  });
});

describe("effort in the planner prompts", () => {
  it("effort ids and the model default are listed next to each model with effort options", () => {
    const prompt = plannerPrompt("goal", catalog);
    expect(prompt).toContain("- claude: opus (effort: low|medium|high; default medium), plain");
    expect(prompt).toContain("- codex: sol (effort: low|xhigh)");
  });

  it("effort guidance asks for low effort for QA, verification, docs and release work", () => {
    for (const prompt of [plannerPrompt("goal", catalog), teamEditPrompt("add qa", team(), catalog)]) {
      expect(prompt).toMatch(/"low" for routine verification, running tests, QA, docs or release work/);
      expect(prompt).toContain("only an effort id listed for its model above");
    }
    expect(teamEditPrompt("add qa", team(), catalog)).toContain("Keep a role's or the orchestrator's effort unless");
  });

  it("effort is part of the JSON example the planner must answer with", () => {
    const prompt = plannerPrompt("goal", catalog);
    const example = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1));
    expect(example.orchestrator.effort).toContain("effort id");
    expect(example.roles[0].effort).toContain("effort id");
  });
});

describe("effort in team edits", () => {
  it("effort of roles and the orchestrator comes from the proposal, and sharedWorkspaces from the current team", () => {
    const draft = team({ orchestrator: { sharedWorkspaces: ["side"] } });
    const proposed = team({ orchestrator: { effort: "high", sharedWorkspaces: ["hijack"] }, roles: [{ name: "design", provider: "codex", model: "sol", effort: "low", folders: [], instructions: "" }] });
    const result = applyTeamEdit(draft, proposed);
    expect(result.orchestrator).toEqual({ workspace: "lead", provider: "claude", model: "opus", effort: "high", sharedWorkspaces: ["side"] });
    expect(result.roles[0]!.effort).toBe("low");
  });

  it("effort change of a role is summarized as the effort field, and of the orchestrator as orchestratorEffort", () => {
    const draft = team();
    const edited = team({ orchestrator: { effort: "high" }, roles: [{ ...draft.roles[0]!, effort: "low" }, { ...draft.roles[1]!, effort: "high", instructions: "Other." }] });
    const summary = summarizeTeamEdit(draft, edited);
    expect(summary.changed).toEqual([{ name: "design", fields: ["effort"] }, { name: "qa", fields: ["effort", "instructions"] }]);
    expect(summary.orchestratorEffort).toBe(true);
    expect(summary.orchestrator).toBe(false);
  });

  it("effort set to nothing on both sides is not a change", () => {
    expect(summarizeTeamEdit(team(), team())).toMatchObject({ changed: [], orchestratorEffort: false });
  });
});

describe("effort and orchestrator reuse", () => {
  const candidate = (over: Partial<OrchestratorCandidate> = {}): OrchestratorCandidate => ({
    id: "o1",
    workspaceId: "wks_lead",
    labels: { "workspace-agents": "orchestrator" },
    archivedAt: null,
    provider: "claude",
    model: "opus",
    currentModeId: "auto",
    ...over,
  });
  const find = (current: Team, agent: OrchestratorCandidate, defaultEffort?: string) => findOrchestrator([agent], "wks_lead", current, "auto", defaultEffort)?.id;

  it("effort empty in the team and an agent on the model default is reused", () => {
    expect(find(team(), candidate({ effectiveThinkingOptionId: "medium" }), "medium")).toBe("o1");
    expect(find(team(), candidate(), "medium")).toBe("o1");
    expect(find(team(), candidate())).toBe("o1");
  });

  it("effort high in the team and an agent on the default is not reused", () => {
    expect(find(team({ orchestrator: { effort: "high" } }), candidate({ effectiveThinkingOptionId: "medium" }), "medium")).toBeUndefined();
  });

  it("effort equal to the model default and an agent on the default is reused", () => {
    expect(find(team({ orchestrator: { effort: "medium" } }), candidate(), "medium")).toBe("o1");
    expect(find(team({ orchestrator: { effort: "medium" } }), candidate({ thinkingOptionId: "medium" }), "medium")).toBe("o1");
  });

  it("effort matching the agent's explicit thinking option is reused, a different one is not", () => {
    expect(find(team({ orchestrator: { effort: "high" } }), candidate({ thinkingOptionId: "high" }), "medium")).toBe("o1");
    expect(find(team({ orchestrator: { effort: "high" } }), candidate({ thinkingOptionId: "low" }), "medium")).toBeUndefined();
  });
});

describe("effort when the server starts the orchestrator", () => {
  let root: string;
  let created: { config: Record<string, unknown> }[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "effort-"));
    mkdirSync(join(root, TEAMS_DIR), { recursive: true });
    created = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (current: Team) => {
    writeFileSync(join(root, TEAMS_DIR, "lead.json"), serializeTeam(current), "utf8");
    const workspace = { id: "wks_lead", projectId: "prj_1", projectCustomName: null, projectDisplayName: "Demo", projectRootPath: root, archivingAt: null, name: "lead", title: "lead", workspaceKind: "directory" };
    return restartOrchestrator({ workspaceId: "wks_lead" }, {
      paseo: {
        projects: { list: async () => ({ projects: [{ projectId: "prj_1", projectCustomName: null, projectDisplayName: "Demo", projectRootPath: root }] }) },
        workspaces: {
          list: async () => ({ entries: [workspace] }),
          ref: () => ({ refresh: async () => workspace, agents: { create: async (input: { config: Record<string, unknown> }) => { created.push(input); return { id: "new-orch" }; } } }),
        },
        providers: { snapshot: async () => ({ entries }) },
        agents: { list: async () => ({ entries: [] }), ref: () => ({ archive: async () => ({}) }) },
      } as never,
    });
  };

  it("effort of the team is passed as thinkingOptionId to the new orchestrator", async () => {
    const result = await run(team({ orchestrator: { effort: "high" }, roles: [{ name: "qa", provider: "claude", model: "opus", effort: "low", folders: [], instructions: "" }] }));
    expect(result).toEqual({ ok: true, orchestratorAgentId: "new-orch", archived: [] });
    expect(created).toHaveLength(1);
    expect(created[0]!.config).toMatchObject({ provider: "claude/opus", modeId: "auto", thinkingOptionId: "high" });
    expect(String(created[0]!.config.systemPrompt)).toContain("| qa | claude/opus | auto | low | (any) |");
  });

  it("effort is left out of the orchestrator's config when the team sets none", async () => {
    await run(team({ roles: [{ name: "qa", provider: "claude", model: "opus", folders: [], instructions: "" }] }));
    expect("thinkingOptionId" in created[0]!.config).toBe(false);
  });

  it("effort that this host cannot run stops the restart before anything starts", async () => {
    const result = await run(team({ orchestrator: { effort: "xhigh" } }));
    expect(result).toMatchObject({ ok: false });
    expect(created).toEqual([]);
  });
});
