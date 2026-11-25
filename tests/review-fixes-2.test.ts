// Regression tests for the server and shared findings of the second review pass (.forge/followups.md, "Second pass 2026-11-25").
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTeam, projectTeamsList, proposeTeam, teamRoster } from "../server/team";
import { buildAgentForest, dismissibleIds, type DashboardAgent } from "../shared/agent-tree";
import { LABEL, PROPOSAL_FOR } from "../shared/cleanup";
import { extractInstructions, extractProposal } from "../shared/proposal";
import { applySubagentUpdate, mergeSubagents, type ProviderSubagent } from "../shared/subagents";
import { parseTeam, serializeTeam, TEAM_FILE, type Team } from "../shared/team";
import { TEAMS_DIR } from "../shared/team-files";

const team = (workspace: string, over: Partial<Team["orchestrator"]> = {}, goal = `Goal of ${workspace}`): Team => ({
  version: 1,
  goal,
  orchestrator: { workspace, provider: "claude", model: "m", ...over },
  roles: [{ name: "qa", provider: "claude", model: "m", folders: [], instructions: "" }],
});

type Agent = { id: string; workspaceId: string; labels: Record<string, string>; archivedAt: string | null; provider?: string; model?: string | null; currentModeId?: string | null; thinkingOptionId?: string | null };
const agent = (id: string, workspaceId: string, labels: Record<string, string>, over: Partial<Agent> = {}): Agent => ({ id, workspaceId, labels, archivedAt: null, ...over });
const claude = { provider: "claude", enabled: true, status: "ready", modes: [{ id: "auto" }], models: [{ id: "m", label: "m", isDefault: true }] };

/** A fake Paseo host with one project, recording what the handlers archive, send and create. */
function host(root: string, titles: string[], options: { agents?: Agent[]; providers?: unknown[]; failArchive?: string[] } = {}) {
  const archived: string[] = [];
  const archivedWorkspaces: string[] = [];
  const sent: string[] = [];
  const created: { workspaceId: string; title: string; config: Record<string, unknown> }[] = [];
  const workspace = (title: string) => ({ id: `wks_${title}`, projectId: "prj_1", projectCustomName: null, projectDisplayName: "Demo", projectRootPath: root, archivingAt: null, name: title, title, workspaceKind: "directory" });
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "prj_1", projectCustomName: null, projectDisplayName: "Demo", projectRootPath: root }] }) },
    workspaces: {
      list: async () => ({ entries: titles.map(workspace) }),
      create: async ({ title }: { title: string }) => ({ id: `wks_${title}` }),
      archive: async (id: string) => { archivedWorkspaces.push(id); return {}; },
      ref: (workspaceId: string) => ({
        refresh: async () => titles.map(workspace).find((entry) => entry.id === workspaceId),
        agents: { create: async (input: { title: string; config: Record<string, unknown> }) => { created.push({ workspaceId, title: input.title, config: input.config }); return { id: `new-${created.length}` }; } },
      }),
    },
    providers: { snapshot: async () => ({ entries: options.providers ?? [claude] }), listFeatures: async () => ({ features: [] }) },
    agents: {
      list: async () => ({ entries: (options.agents ?? []).map((value) => ({ agent: { provider: "claude", model: "m", currentModeId: "auto", createdAt: "2026-11-25T00:00:00Z", ...value } })) }),
      ref: (id: string) => ({
        archive: async () => { if (options.failArchive?.includes(id)) throw new Error("archive refused"); archived.push(id); return {}; },
        send: async () => { sent.push(id); },
      }),
    },
  };
  return { context: { paseo: paseo as never }, archived, archivedWorkspaces, sent, created };
}

describe("second review pass", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "review-fixes-2-"));
    mkdirSync(join(root, TEAMS_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (file: string, value: Team) => writeFileSync(join(root, file), serializeTeam(value), "utf8");
  const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));

  describe("S2: Apply never archives a Team planner workspace a team uses", () => {
    it("a Team planner workspace shared with the team keeps the orchestrator Apply just started there", async () => {
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["Team planner"] }));
      const { context, archivedWorkspaces, created } = host(root, ["lead", "Team planner"]);
      const result = await applyTeam({ workspaceId: "wks_Team planner", team: team("lead", { sharedWorkspaces: ["Team planner"] }) }, context);
      expect(result).toMatchObject({ ok: true });
      expect(created.map((entry) => entry.workspaceId)).toEqual(["wks_Team planner"]);
      expect(archivedWorkspaces).toEqual([]);
    });

    it("another team's home titled Team planner is kept", async () => {
      write(`${TEAMS_DIR}/team-planner.json`, team("Team planner"));
      const { context, archivedWorkspaces } = host(root, ["a", "Team planner"]);
      expect(await applyTeam({ workspaceId: "wks_a", team: team("a") }, context)).toMatchObject({ ok: true });
      expect(archivedWorkspaces).toEqual([]);
    });

    it("a Team planner workspace is kept when its planner could not be archived", async () => {
      const planner = agent("p1", "wks_Team planner", { [LABEL]: "planner", [PROPOSAL_FOR]: "prj_1" });
      const { context, archivedWorkspaces } = host(root, ["Team planner"], { agents: [planner], failArchive: ["p1"] });
      const result = await applyTeam({ projectId: "prj_1", team: team("a") }, context);
      expect(result).toMatchObject({ ok: true, cleanup: [expect.stringContaining("planner p1")] });
      expect(archivedWorkspaces).toEqual([]);
    });

    it("an emptied Team planner workspace no team uses is still archived", async () => {
      const planner = agent("p1", "wks_Team planner", { [LABEL]: "planner", [PROPOSAL_FOR]: "prj_1" });
      const { context, archived, archivedWorkspaces } = host(root, ["Team planner"], { agents: [planner] });
      expect(await applyTeam({ projectId: "prj_1", team: team("a") }, context)).toMatchObject({ ok: true, cleanup: [] });
      expect(archived).toEqual(["p1"]);
      expect(archivedWorkspaces).toEqual(["wks_Team planner"]);
    });
  });

  describe("S3: hiding a closed parent never hides descendants that still need the user", () => {
    const dash = (id: string, over: Partial<DashboardAgent> = {}): DashboardAgent => ({ id, workspaceId: "w", provider: "claude", model: "m", title: id, status: "idle", labels: {}, createdAt: `2026-11-25T00:00:0${id.length}Z`, ...over });
    const agents = [
      dash("p", { status: "closed", archivedAt: "2026-11-25T00:00:00Z" }),
      dash("err", { status: "error", parentAgentId: "p" }),
      dash("perm", { status: "idle", parentAgentId: "p", requiresAttention: true, attentionReason: "permission" }),
    ];

    it("a closed parent of an agent stopped on an error or waiting on a permission is not dismissible", () => {
      expect(dismissibleIds(buildAgentForest(agents, ["w"], { showClosed: true }))).toEqual([]);
    });

    it("a closed parent of an unarchived idle agent is not dismissible", () => {
      const idle = [agents[0]!, dash("idle", { parentAgentId: "p" })];
      expect(dismissibleIds(buildAgentForest(idle, ["w"], { showClosed: true }))).toEqual([]);
    });

    it("a closed parent whose descendants are all closed is still dismissible", () => {
      const closed = [agents[0]!, dash("done", { status: "closed", parentAgentId: "p" })];
      expect(dismissibleIds(buildAgentForest(closed, ["w"], { showClosed: true }))).toEqual(["p", "done"]);
    });

    it("an already dismissed parent still takes its closed descendants with it", () => {
      const closed = [agents[0]!, dash("done", { status: "closed", parentAgentId: "p" })];
      const forest = buildAgentForest(closed, ["w"], { showClosed: true, dismissed: ["p"] });
      expect([...forest.trees, ...forest.solo]).toEqual([]);
    });
  });

  describe("S4: Apply keeps the shared workspaces on disk", () => {
    it("a stale draft doesn't drop a workspace shared since it was opened", async () => {
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["side", "extra"] }));
      const { context } = host(root, ["lead", "side", "extra"]);
      expect(await applyTeam({ workspaceId: "wks_lead", team: team("lead", { sharedWorkspaces: ["side"] }, "New goal") }, context)).toMatchObject({ ok: true });
      expect(read(`${TEAMS_DIR}/lead.json`)).toMatchObject({ goal: "New goal", orchestrator: { sharedWorkspaces: ["side", "extra"] } });
    });

    it("a stale draft doesn't re-add a workspace unshared since it was opened", async () => {
      write(`${TEAMS_DIR}/lead.json`, team("lead"));
      const { context } = host(root, ["lead", "side"]);
      expect(await applyTeam({ workspaceId: "wks_lead", team: team("lead", { sharedWorkspaces: ["side"] }) }, context)).toMatchObject({ ok: true });
      expect("sharedWorkspaces" in read(`${TEAMS_DIR}/lead.json`).orchestrator).toBe(false);
    });
  });

  describe("S11: Apply reports other workspaces whose orchestrator is on the old configuration", () => {
    it("a shared workspace's orchestrator on the old model is told, kept, and reported as a notice (V1: not in cleanup)", async () => {
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["side"] }));
      const { context, archived, sent } = host(root, ["lead", "side"], { agents: [agent("orch-side", "wks_side", { [LABEL]: "orchestrator" }, { model: "old" })] });
      const result = await applyTeam({ workspaceId: "wks_lead", team: team("lead", { sharedWorkspaces: ["side"] }) }, context);
      expect(result).toMatchObject({ ok: true, cleanup: [], notices: [expect.stringMatching(/orchestrator orch-side in side .*claude\/old.*Reset session/)] });
      expect(sent).toEqual(["orch-side"]);
      expect(archived).toEqual([]);
    });

    it("an orchestrator already on the team's model is not reported", async () => {
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["side"] }));
      const { context } = host(root, ["lead", "side"], { agents: [agent("orch-side", "wks_side", { [LABEL]: "orchestrator" })] });
      expect(await applyTeam({ workspaceId: "wks_lead", team: team("lead", { sharedWorkspaces: ["side"] }) }, context)).toMatchObject({ ok: true, cleanup: [], notices: [] });
    });
  });

  describe("S12: two files for the same home are handled as one team", () => {
    beforeEach(() => {
      write(TEAM_FILE, team("lead", { sharedWorkspaces: ["side"] }, "Legacy goal"));
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["side"] }, "Stale goal"));
    });

    it("the Agent teams list shows one row, the file the panel reads", async () => {
      const { context } = host(root, ["lead", "side"]);
      const [project] = await projectTeamsList({}, context);
      expect(project!.teams.map((entry) => [entry.file, entry.goal])).toEqual([[TEAM_FILE, "Legacy goal"]]);
    });

    it("the roster has one entry per team workspace", async () => {
      const { context } = host(root, ["lead", "side"]);
      const roster = await teamRoster({ workspaceId: "wks_lead" }, context);
      expect(roster.teams.map((entry) => entry.orchestratorWorkspaceId)).toEqual(["wks_lead", "wks_side"]);
    });

    it("Apply rewrites every file of the team", async () => {
      const { context } = host(root, ["lead", "side"]);
      expect(await applyTeam({ workspaceId: "wks_lead", team: team("lead", {}, "New goal") }, context)).toMatchObject({ ok: true });
      expect(read(TEAM_FILE).goal).toBe("New goal");
      expect(read(`${TEAMS_DIR}/lead.json`).goal).toBe("New goal");
    });
  });

  describe("S13: shared workspaces are distinct and never the home", () => {
    it("a duplicate shared workspace is rejected, case-insensitively", () => {
      const result = parseTeam(JSON.stringify(team("lead", { sharedWorkspaces: ["side", "SIDE"] })));
      expect(result).toEqual({ ok: false, errors: [expect.stringContaining('duplicate shared workspace "SIDE"')] });
    });

    it("the home listed as a shared workspace is rejected", () => {
      const result = parseTeam(JSON.stringify(team("lead", { sharedWorkspaces: [" Lead "] })));
      expect(result).toEqual({ ok: false, errors: [expect.stringContaining('shared workspace "Lead" is the team\'s home')] });
    });

    it("distinct shared workspaces still parse", () => {
      expect(parseTeam(JSON.stringify(team("lead", { sharedWorkspaces: ["side", "extra"] })))).toMatchObject({ ok: true });
    });
  });

  describe("S15: a planner's JSON is found despite braces in the text around it", () => {
    it("a fenced block after prose with braces", () => {
      expect(extractInstructions('Updated {role} prompt:\n```json\n{"instructions":"Run tests."}\n```')).toEqual({ ok: true, instructions: "Run tests." });
    });

    it("a bare object after prose with a template placeholder", () => {
      expect(extractInstructions('Use ${var} like this: {"instructions":"Run tests."}')).toEqual({ ok: true, instructions: "Run tests." });
    });

    it("a team in a fence followed by a note with braces", () => {
      const json = JSON.stringify(team("lead"));
      expect(extractProposal(`\`\`\`json\n${json}\n\`\`\`\nNote: {qa} runs last.`)).toMatchObject({ ok: true, team: { orchestrator: { workspace: "lead" } } });
    });

    it("an answer without JSON still says so", () => {
      expect(extractInstructions("no json here")).toEqual({ ok: false, errors: ["the planner's answer has no JSON instructions"] });
    });
  });

  describe("S20: a removed sub-agent stays removed", () => {
    const boot: ProviderSubagent[] = [{ id: "s1", parentAgentId: "a", parentSubagentId: null, title: "explore", description: null, status: "completed", createdAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-25T00:00:00Z" }];
    const remove = { kind: "remove", parentAgentId: "a", subagentId: "s1" };

    it("a remove event hides a sub-agent known only from the timeline", () => {
      expect(mergeSubagents(boot, applySubagentUpdate({}, remove))).toEqual([]);
    });

    it("a remove event hides a sub-agent that was live", () => {
      const live = applySubagentUpdate({}, { kind: "upsert", subagent: { ...boot[0], status: "running" } });
      expect(mergeSubagents(boot, applySubagentUpdate(live, remove))).toEqual([]);
    });

    it("a later upsert brings it back", () => {
      const removed = applySubagentUpdate({}, remove);
      const back = applySubagentUpdate(removed, { kind: "upsert", subagent: { ...boot[0], status: "running" } });
      expect(mergeSubagents(boot, back).map((entry) => [entry.id, entry.status])).toEqual([["s1", "running"]]);
    });
  });

  describe("S21: the planner never runs on an unselectable model", () => {
    it("an unselectable default model is skipped", async () => {
      const providers = [{ ...claude, models: [{ id: "hidden", label: "hidden", isDefault: true, isSelectable: false }, { id: "m", label: "m" }] }];
      const { context, created } = host(root, ["a"], { providers });
      await proposeTeam({ workspaceId: "wks_a", goal: "ship" }, context);
      expect(created[0]!.config.provider).toBe("claude/m");
    });
  });

  describe("S22: malformed Claude permissions are not rewritten", () => {
    const providers = [claude, { provider: "antigravity", enabled: true, status: "ready", modes: [{ id: "full-access", isUnattended: true }], models: [{ id: "g", label: "g" }] }];
    const withUnattendedRole: Team = { ...team("lead"), roles: [{ name: "qa", provider: "antigravity", model: "g", folders: [], instructions: "" }] };

    for (const [name, permissions] of [["a string", "bad"], ["an array", ["x"]], ["an allow list that is not a list", { allow: "Bash(ls)" }]] as const) {
      it(`permissions as ${name} stops Apply and leaves the file alone`, async () => {
        mkdirSync(join(root, ".claude"), { recursive: true });
        const text = JSON.stringify({ permissions }, null, 2);
        writeFileSync(join(root, ".claude/settings.local.json"), text, "utf8");
        const { context, created } = host(root, ["lead"], { providers });
        const result = await applyTeam({ workspaceId: "wks_lead", team: withUnattendedRole }, context);
        expect(result).toEqual({ ok: false, errors: [expect.stringContaining(".claude/settings.local.json")] });
        expect(readFileSync(join(root, ".claude/settings.local.json"), "utf8")).toBe(text);
        expect(created).toEqual([]);
      });
    }
  });
});

describe("S20: a removed sub-agent's tombstone", () => {
  it("is not running, so a removed running sub-agent doesn't keep the dashboard animating", () => {
    const live = applySubagentUpdate({}, { kind: "upsert", subagent: { id: "s1", parentAgentId: "a", parentSubagentId: null, title: null, description: null, status: "running", createdAt: "t", updatedAt: "t" } });
    const removed = applySubagentUpdate(live, { kind: "remove", parentAgentId: "a", subagentId: "s1" });
    expect(Object.values(removed).some((entry) => entry.status === "running")).toBe(false);
  });
});
