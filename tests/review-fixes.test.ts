// Regression tests for the server findings of the 2026-11-25 code review (.forge/followups.md, R1–R12).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTeam, cancelPlanner, improveInstructions, instructionsProposal, projectTeamsList, proposeTeamEdit, readTeam, restoreTeam, teamEditProposal } from "../server/team";
import { EDIT_FOR, findOrchestrator, LABEL, plannerCleanup, PROPOSAL_FOR, type OrchestratorCandidate } from "../shared/cleanup";
import { en, ja, ko, zh } from "../shared/messages";
import { teamPlannerCancelRpc } from "../shared/rpc";
import { serializeTeam, type Team } from "../shared/team";
import { TEAMS_DIR } from "../shared/team-files";

const team = (workspace: string, over: Partial<Team["orchestrator"]> = {}): Team => ({
  version: 1,
  goal: `Goal of ${workspace}`,
  orchestrator: { workspace, provider: "claude", model: "m", ...over },
  roles: [{ name: "qa", provider: "claude", model: "m", folders: [], instructions: "" }],
});

type Agent = { id: string; workspaceId: string; labels: Record<string, string>; archivedAt: string | null; provider?: string; model?: string | null; currentModeId?: string | null; thinkingOptionId?: string | null; effectiveThinkingOptionId?: string | null; createdAt?: string };
type Finish = { status: "timeout" } | { status: "error"; error: string } | { status: "permission" } | { status: "idle"; lastMessage: string | null };

/** A fake Paseo host with one or more projects, recording what the handlers archive, send and create. */
function host(projects: { id: string; root: string; workspaces: string[] }[], agents: Agent[] = [], finish: Record<string, Finish> = {}) {
  const archived: string[] = [];
  const sent: string[] = [];
  const created: { workspaceId: string; title: string; labels: Record<string, string> }[] = [];
  const workspace = (projectId: string, root: string, title: string) => ({ id: `wks_${title}`, projectId, projectCustomName: null, projectDisplayName: projectId, projectRootPath: root, archivingAt: null, name: title, title, workspaceKind: "directory" });
  const workspaces = () => projects.flatMap((project) => project.workspaces.map((title) => workspace(project.id, project.root, title)));
  const paseo = {
    projects: { list: async () => ({ projects: projects.map((project) => ({ projectId: project.id, projectCustomName: null, projectDisplayName: project.id, projectRootPath: project.root })) }) },
    workspaces: {
      list: async () => ({ entries: workspaces() }),
      create: async ({ title }: { title: string }) => ({ id: `wks_${title}` }),
      archive: async (id: string) => { archived.push(id); return {}; },
      ref: (workspaceId: string) => ({
        refresh: async () => workspaces().find((entry) => entry.id === workspaceId),
        agents: { create: async (input: { title: string; labels: Record<string, string> }) => { created.push({ workspaceId, title: input.title, labels: input.labels }); return { id: `new-${created.length}` }; } },
      }),
    },
    providers: { snapshot: async () => ({ entries: [{ provider: "claude", enabled: true, status: "ready", modes: [{ id: "auto" }], models: [{ id: "m", label: "m", isDefault: true }] }] }) },
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent: { provider: "claude", model: "m", currentModeId: "auto", createdAt: "2026-11-25T00:00:00Z", ...agent } })) }),
      ref: (id: string) => ({
        archive: async () => { archived.push(id); return {}; },
        send: async () => { sent.push(id); },
        waitForFinish: async () => finish[id] ?? { status: "timeout" },
      }),
    },
  };
  return { context: { paseo: paseo as never }, archived, sent, created };
}

const agent = (id: string, workspaceId: string, labels: Record<string, string>, over: Partial<Agent> = {}): Agent => ({ id, workspaceId, labels, archivedAt: null, ...over });

describe("review fixes", () => {
  let root: string;
  let other: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "review-fixes-"));
    other = mkdtempSync(join(tmpdir(), "review-fixes-other-"));
    mkdirSync(join(root, TEAMS_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  const write = (base: string, name: string, value: unknown) => {
    mkdirSync(join(base, TEAMS_DIR), { recursive: true });
    writeFileSync(join(base, TEAMS_DIR, name), typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  };

  describe("R1: an unreadable team file", () => {
    it("is reported for its project, and the other projects and teams still load", async () => {
      write(root, "good.json", team("lead"));
      mkdirSync(join(root, TEAMS_DIR, "broken.json"));
      write(other, "other.json", team("main"));
      const { context } = host([{ id: "prj_1", root, workspaces: ["lead"] }, { id: "prj_2", root: other, workspaces: ["main"] }]);
      const result = await projectTeamsList({}, context);
      const first = result.find((project) => project.id === "prj_1")!;
      expect(first.teams.map((entry) => entry.file)).toEqual([`${TEAMS_DIR}/good.json`]);
      expect(first.errors).toEqual([expect.stringContaining(`${TEAMS_DIR}/broken.json:`)]);
      expect(result.find((project) => project.id === "prj_2")!.teams.map((entry) => entry.file)).toEqual([`${TEAMS_DIR}/other.json`]);
    });

    it("does not stop team.read of that project", async () => {
      write(root, "good.json", team("lead"));
      mkdirSync(join(root, TEAMS_DIR, "broken.json"));
      const { context } = host([{ id: "prj_1", root, workspaces: ["lead"] }]);
      const result = await readTeam({ workspaceId: "wks_lead" }, context);
      expect(result.team?.orchestrator.workspace).toBe("lead");
      expect(result.errors).toEqual([expect.stringContaining(`${TEAMS_DIR}/broken.json:`)]);
    });

    it("a project whose teams folder can't be listed is shown with an error instead of failing every project", async () => {
      rmSync(join(root, TEAMS_DIR), { recursive: true });
      writeFileSync(join(root, TEAMS_DIR), "not a folder", "utf8");
      write(other, "other.json", team("main"));
      const { context } = host([{ id: "prj_1", root, workspaces: ["lead"] }, { id: "prj_2", root: other, workspaces: ["main"] }]);
      const result = await projectTeamsList({}, context);
      expect(result.find((project) => project.id === "prj_1")).toMatchObject({ teams: [], errors: [expect.any(String)] });
      expect(result.find((project) => project.id === "prj_2")!.teams).toHaveLength(1);
    });
  });

  describe("R2: Apply archives only the planners of what it applied", () => {
    const ws = (id: string, title: string) => ({ id, name: id, title });

    it("plannerCleanup keeps planners proposing, editing or improving for another workspace", () => {
      const agents = [
        agent("mine", "wks_a", { [LABEL]: "planner", [PROPOSAL_FOR]: "wks_a" }),
        agent("b-team", "wks_b", { [LABEL]: "planner", [PROPOSAL_FOR]: "wks_b" }),
        agent("b-edit", "wks_b", { [LABEL]: "planner", [EDIT_FOR]: "wks_b" }),
        agent("project-new", "wks_b", { [LABEL]: "planner", [PROPOSAL_FOR]: "prj_1" }),
        agent("a-edit", "wks_a", { [LABEL]: "planner", [EDIT_FOR]: "wks_a" }),
      ];
      expect(plannerCleanup([ws("wks_a", "a"), ws("wks_b", "b")], agents, team("a"), ["wks_a"]).agents).toEqual(["mine", "a-edit"]);
    });

    it("plannerCleanup archives an unlabelled old planner only in the applied team's workspaces", () => {
      const agents = [agent("old-a", "wks_a", { [LABEL]: "planner" }), agent("old-b", "wks_b", { [LABEL]: "planner" })];
      expect(plannerCleanup([ws("wks_a", "a"), ws("wks_b", "b")], agents, team("a"), ["wks_a"]).agents).toEqual(["old-a"]);
    });

    it("plannerCleanup keeps a Team planner workspace that still has another target's planner", () => {
      const agents = [agent("mine", "wks_plan", { [LABEL]: "planner", [PROPOSAL_FOR]: "prj_1" }), agent("theirs", "wks_plan", { [LABEL]: "planner", [EDIT_FOR]: "wks_b" })];
      expect(plannerCleanup([ws("wks_plan", "Team planner")], agents, team("a"), ["prj_1"])).toEqual({ agents: ["mine"], workspaces: [] });
    });

    it("applying in workspace A leaves workspace B's in-flight planners running", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a", "b"] }], [
        agent("a-team", "wks_a", { [LABEL]: "planner", [PROPOSAL_FOR]: "wks_a" }),
        agent("b-team", "wks_b", { [LABEL]: "planner", [PROPOSAL_FOR]: "wks_b" }),
        agent("b-edit", "wks_b", { [LABEL]: "planner", [EDIT_FOR]: "wks_b" }),
      ]);
      const result = await applyTeam({ workspaceId: "wks_a", team: team("a") }, context);
      expect(result).toMatchObject({ ok: true, cleanup: [] });
      expect(archived).toEqual(["a-team"]);
    });

    it("edit and instructions planners carry the target they work for", async () => {
      const { context, created } = host([{ id: "prj_1", root, workspaces: ["a"] }]);
      await proposeTeamEdit({ workspaceId: "wks_a", request: "add qa", team: team("a") }, context);
      await improveInstructions({ workspaceId: "wks_a", role: { name: "qa", folders: [], instructions: "" }, request: "", team: { goal: "", orchestratorWorkspace: "a", roles: [] } }, context);
      expect(created.map((entry) => entry.labels)).toEqual([{ [LABEL]: "planner", [EDIT_FOR]: "wks_a" }, { [LABEL]: "planner", [EDIT_FOR]: "wks_a" }]);
    });
  });

  describe("R4: edit and instructions planners are archived once they stop, and can be cancelled", () => {
    it("a team editor that failed is archived", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [], { ed: { status: "error", error: "boom" } });
      expect(await teamEditProposal({ agentId: "ed" }, context)).toEqual({ status: "failed", errors: ["boom"] });
      expect(archived).toEqual(["ed"]);
    });

    it("a team editor whose answer doesn't parse is archived", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [], { ed: { status: "idle", lastMessage: "no json here" } });
      expect(await teamEditProposal({ agentId: "ed" }, context)).toMatchObject({ status: "failed" });
      expect(archived).toEqual(["ed"]);
    });

    it("an instructions planner is archived when it answered", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [], { ins: { status: "idle", lastMessage: JSON.stringify({ instructions: "Do it." }) } });
      expect(await instructionsProposal({ agentId: "ins" }, context)).toEqual({ status: "done", instructions: "Do it." });
      expect(archived).toEqual(["ins"]);
    });

    it("an instructions planner is archived when it failed", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [], { ins: { status: "error", error: "boom" } });
      expect(await instructionsProposal({ agentId: "ins" }, context)).toMatchObject({ status: "failed" });
      expect(archived).toEqual(["ins"]);
    });

    it("a planner waiting for a permission is kept so the user can answer it", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [], { ins: { status: "permission" } });
      expect(await instructionsProposal({ agentId: "ins" }, context)).toMatchObject({ status: "failed" });
      expect(archived).toEqual([]);
    });

    it("team.planner.cancel archives an in-flight planner", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [agent("ed", "wks_a", { [LABEL]: "planner", [EDIT_FOR]: "wks_a" })]);
      expect(await cancelPlanner({ agentId: "ed" }, context)).toEqual({});
      expect(archived).toEqual(["ed"]);
    });

    it("team.planner.cancel ignores an agent that is gone or already archived", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [agent("ed", "wks_a", { [LABEL]: "planner" }, { archivedAt: "2026-11-25T00:00:00Z" })]);
      expect(await cancelPlanner({ agentId: "ed" }, context)).toEqual({});
      expect(await cancelPlanner({ agentId: "missing" }, context)).toEqual({});
      expect(archived).toEqual([]);
    });

    it("team.planner.cancel refuses an agent that isn't a planner", async () => {
      const { context, archived } = host([{ id: "prj_1", root, workspaces: ["a"] }], [agent("orch", "wks_a", { [LABEL]: "orchestrator" })]);
      await expect(cancelPlanner({ agentId: "orch" }, context)).rejects.toThrow(/not a team planner/);
      expect(archived).toEqual([]);
    });

    it("team.planner.cancel's contract takes an agent id and returns an empty object", () => {
      expect(teamPlannerCancelRpc.name).toBe("team.planner.cancel");
      expect(teamPlannerCancelRpc.input.safeParse({ agentId: "x" }).success).toBe(true);
      expect(teamPlannerCancelRpc.output.safeParse({}).success).toBe(true);
    });
  });

  describe("R6: a new team can't overwrite another team with the same home", () => {
    it("Apply from the project refuses a home that already has a team and leaves its file alone", async () => {
      write(root, "a.json", serializeTeam(team("a")));
      const before = readFileSync(join(root, TEAMS_DIR, "a.json"), "utf8");
      const { context, created } = host([{ id: "prj_1", root, workspaces: ["a"] }]);
      const draft = { ...team("a"), goal: "Something else", roles: [{ name: "dev", provider: "claude", model: "m", folders: [], instructions: "" }] };
      const result = await applyTeam({ projectId: "prj_1", team: draft }, context);
      expect(result).toEqual({ ok: false, errors: ['orchestrator: workspace "a" belongs to another team'] });
      expect(readFileSync(join(root, TEAMS_DIR, "a.json"), "utf8")).toBe(before);
      expect(created).toEqual([]);
    });

    it("Apply from a workspace that isn't the team's refuses that team's home", async () => {
      write(root, "a.json", serializeTeam(team("a")));
      const { context } = host([{ id: "prj_1", root, workspaces: ["a", "b"] }]);
      const result = await applyTeam({ workspaceId: "wks_b", team: team("a") }, context);
      expect(result).toEqual({ ok: false, errors: ['orchestrator: workspace "a" belongs to another team'] });
    });

    it("Apply from the team's home or a shared workspace, and Restore, still rewrite the team", async () => {
      write(root, "a.json", serializeTeam(team("a", { sharedWorkspaces: ["s"] })));
      const { context } = host([{ id: "prj_1", root, workspaces: ["a", "s"] }]);
      expect(await applyTeam({ workspaceId: "wks_a", team: team("a") }, context)).toMatchObject({ ok: true });
      expect(await applyTeam({ workspaceId: "wks_s", team: team("a") }, context)).toMatchObject({ ok: true });
      expect(await restoreTeam({ projectId: "prj_1", file: `${TEAMS_DIR}/a.json` }, context)).toMatchObject({ ok: true });
    });
  });

  describe("R7: Apply doesn't leave a second orchestrator in the workspace", () => {
    it("an orchestrator on another model is archived before the new one starts", async () => {
      write(root, "a.json", serializeTeam(team("a")));
      const { context, archived, created } = host([{ id: "prj_1", root, workspaces: ["a"] }], [agent("old", "wks_a", { [LABEL]: "orchestrator" }, { model: "other" })]);
      const result = await applyTeam({ workspaceId: "wks_a", team: team("a") }, context);
      expect(result).toMatchObject({ ok: true, orchestratorAgentId: "new-1", cleanup: [] });
      expect(archived).toEqual(["old"]);
      expect(created.map((entry) => entry.title)).toEqual(["Orchestrator"]);
    });

    it("an orchestrator on the same model and mode is kept and told to re-read the team", async () => {
      write(root, "a.json", serializeTeam(team("a")));
      const { context, archived, sent, created } = host([{ id: "prj_1", root, workspaces: ["a"] }], [agent("old", "wks_a", { [LABEL]: "orchestrator" })]);
      expect(await applyTeam({ workspaceId: "wks_a", team: team("a") }, context)).toMatchObject({ ok: true, orchestratorAgentId: "old" });
      expect(archived).toEqual([]);
      expect(sent).toEqual(["old"]);
      expect(created).toEqual([]);
    });

    const orchestrator = (over: Partial<OrchestratorCandidate>): OrchestratorCandidate => ({ id: "o1", workspaceId: "wks_a", labels: { [LABEL]: "orchestrator" }, archivedAt: null, provider: "claude", model: "m", currentModeId: "auto", ...over });

    it("an unset team effort matches an agent started without one on a model with no default effort", () => {
      // OpenCode and Pi agents started without a thinking option report "default" or "off" as their effective one.
      expect(findOrchestrator([orchestrator({ thinkingOptionId: null, effectiveThinkingOptionId: "default" })], "wks_a", team("a"), "auto", undefined)?.id).toBe("o1");
      expect(findOrchestrator([orchestrator({ thinkingOptionId: null, effectiveThinkingOptionId: "off" })], "wks_a", team("a"), "auto", undefined)?.id).toBe("o1");
    });

    it("an unset team effort doesn't match an agent started with an explicit effort", () => {
      expect(findOrchestrator([orchestrator({ thinkingOptionId: "high", effectiveThinkingOptionId: "high" })], "wks_a", team("a"), "auto", undefined)).toBeUndefined();
      expect(findOrchestrator([orchestrator({ thinkingOptionId: "high", effectiveThinkingOptionId: "high" })], "wks_a", team("a"), "auto", "medium")).toBeUndefined();
    });
  });

  describe("R8: a workspace that is only an old role workspace", () => {
    it("shows no team, and its title is taken by the legacy team", async () => {
      write(root, "lead.json", { ...team("lead"), roles: [{ name: "qa", provider: "claude", model: "m", folders: [], instructions: "", workspace: "old-qa" }] });
      const { context } = host([{ id: "prj_1", root, workspaces: ["lead", "old-qa"] }]);
      const result = await readTeam({ workspaceId: "wks_old-qa" }, context);
      expect(result).toMatchObject({ team: null, file: null, home: false, sharedWorkspaces: [] });
      expect(result.takenWorkspaces).toContain("old-qa");
      expect(result.projectTeams.map((entry) => entry.workspace)).toEqual(["lead"]);
      expect(existsSync(join(root, TEAMS_DIR, "lead.json"))).toBe(true);
    });
  });

  describe("R12: role count plural", () => {
    it("English says 1 role and 2 roles", () => {
      expect(en.screen.roles_one.replace("{{count}}", "1")).toBe("1 role");
      expect(en.screen.roles_other.replace("{{count}}", "2")).toBe("2 roles");
    });

    it("every language has both plural forms with the count placeholder", () => {
      for (const resource of [ko, ja, zh]) {
        expect(resource.screen.roles_one).toContain("{{count}}");
        expect(resource.screen.roles_other).toContain("{{count}}");
      }
    });
  });
});
