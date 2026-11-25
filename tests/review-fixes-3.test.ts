// Regression tests for the fixer's defects found in "Verification 2026-11-25" (.forge/followups.md): V1, V8, S12, S20.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTeam, restoreTeam, shareWorkspace, unshareWorkspace } from "../server/team";
import { type AgentForest, type AgentNode, buildAgentForest, type DashboardAgent, dismissibleIds } from "../shared/agent-tree";
import { LABEL, PROPOSAL_FOR } from "../shared/cleanup";
import { en, ja, ko, zh } from "../shared/messages";
import { teamApplyRpc, teamShareRpc } from "../shared/rpc";
import { applySubagentUpdate, mergeSubagents, type ProviderSubagent } from "../shared/subagents";
import { serializeTeam, TEAM_FILE, type Team } from "../shared/team";
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
function host(root: string, titles: string[], options: { agents?: Agent[]; failArchive?: string[] } = {}) {
  const archived: string[] = [];
  const sent: { id: string; message: string }[] = [];
  const created: { workspaceId: string; config: Record<string, unknown> }[] = [];
  const workspace = (title: string) => ({ id: `wks_${title}`, projectId: "prj_1", projectCustomName: null, projectDisplayName: "Demo", projectRootPath: root, archivingAt: null, name: title, title, workspaceKind: "directory" });
  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "prj_1", projectCustomName: null, projectDisplayName: "Demo", projectRootPath: root }] }) },
    workspaces: {
      list: async () => ({ entries: titles.map(workspace) }),
      create: async ({ title }: { title: string }) => ({ id: `wks_${title}` }),
      archive: async () => ({}),
      ref: (workspaceId: string) => ({
        refresh: async () => titles.map(workspace).find((entry) => entry.id === workspaceId),
        agents: { create: async (input: { config: Record<string, unknown> }) => { created.push({ workspaceId, config: input.config }); return { id: `new-${created.length}` }; } },
      }),
    },
    providers: { snapshot: async () => ({ entries: [claude] }), listFeatures: async () => ({ features: [] }) },
    agents: {
      list: async () => ({ entries: (options.agents ?? []).map((value) => ({ agent: { provider: "claude", model: "m", currentModeId: "auto", createdAt: "2026-11-25T00:00:00Z", ...value } })) }),
      ref: (id: string) => ({
        archive: async () => { if (options.failArchive?.includes(id)) throw new Error("archive refused"); archived.push(id); return {}; },
        send: async (message: string) => { sent.push({ id, message }); },
      }),
    },
  };
  return { context: { paseo: paseo as never }, archived, sent, created };
}

describe("third review pass (server)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "review-fixes-3-"));
    mkdirSync(join(root, TEAMS_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (file: string, value: Team) => writeFileSync(join(root, file), serializeTeam(value), "utf8");
  const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
  const outdated = /orchestrator orch-side in side .*claude\/old.*Reset session/;

  describe("V1: advisories are notices, failures are cleanup", () => {
    it("Apply reports an outdated orchestrator in another workspace as a notice, not as a cleanup failure", async () => {
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["side"] }));
      const { context } = host(root, ["lead", "side"], { agents: [agent("orch-side", "wks_side", { [LABEL]: "orchestrator" }, { model: "old" })] });
      const result = await applyTeam({ workspaceId: "wks_lead", team: team("lead", { sharedWorkspaces: ["side"] }) }, context);
      expect(result).toMatchObject({ ok: true, cleanup: [], notices: [expect.stringMatching(outdated)] });
    });

    it("a planner that could not be archived stays in cleanup", async () => {
      const planner = agent("p1", "wks_Team planner", { [LABEL]: "planner", [PROPOSAL_FOR]: "prj_1" });
      const { context } = host(root, ["Team planner"], { agents: [planner], failArchive: ["p1"] });
      const result = await applyTeam({ projectId: "prj_1", team: team("a") }, context);
      expect(result).toMatchObject({ ok: true, cleanup: [expect.stringContaining("planner p1")], notices: [] });
    });

    it("the workspace's old orchestrator that could not be archived stays in cleanup", async () => {
      const old = agent("orch-old", "wks_lead", { [LABEL]: "orchestrator" }, { model: "old" });
      const { context } = host(root, ["lead"], { agents: [old], failArchive: ["orch-old"] });
      const result = await applyTeam({ workspaceId: "wks_lead", team: team("lead") }, context);
      expect(result).toMatchObject({ ok: true, cleanup: [expect.stringContaining("orchestrator orch-old")], notices: [] });
    });

    it("every ok result carries notices, even when empty (apply and restore)", async () => {
      const { context } = host(root, ["lead"]);
      expect(await applyTeam({ workspaceId: "wks_lead", team: team("lead") }, context)).toMatchObject({ ok: true, cleanup: [], notices: [] });
      expect(await restoreTeam({ projectId: "prj_1", file: `${TEAMS_DIR}/lead.json` }, context)).toMatchObject({ ok: true, cleanup: [], notices: [] });
    });

    it("Share doesn't change the orchestrator's model, so it reports no outdated orchestrators; it still tells them", async () => {
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["side"] }));
      const { context, sent } = host(root, ["lead", "side", "extra"], { agents: [agent("orch-side", "wks_side", { [LABEL]: "orchestrator" }, { model: "old" })] });
      const result = await shareWorkspace({ projectId: "prj_1", file: `${TEAMS_DIR}/lead.json`, workspaceId: "wks_extra" }, context);
      expect(result).toMatchObject({ ok: true, cleanup: [], notices: [] });
      expect(sent.map((entry) => entry.id)).toEqual(["orch-side"]);
    });

    it("the apply/share/restore output schema requires notices on an ok result", () => {
      const applied = { ok: true, file: "/p/.agents/teams/lead.json", workspaces: [], orchestratorAgentId: "agt_1", cleanup: [], permission: null };
      expect(teamApplyRpc.output.safeParse({ ...applied, notices: ["x"] }).success).toBe(true);
      expect(teamApplyRpc.output.safeParse(applied).success).toBe(false);
      expect(teamShareRpc.output).toBe(teamApplyRpc.output);
    });

    it("result.cleanupFailed no longer names the planner in any language and keeps {{failure}}", () => {
      const planner = { en: /planner/i, ko: /계획 에이전트/, ja: /プランナー/, zh: /规划器/ };
      for (const [code, resource] of Object.entries({ en, ko, ja, zh })) {
        const text = resource.result.cleanupFailed;
        expect(text).toContain("{{failure}}");
        expect(text).not.toMatch(planner[code as keyof typeof planner]);
      }
    });
  });

  describe("S12: share and unshare act on the requested file when two files of one home diverged", () => {
    beforeEach(() => {
      write(TEAM_FILE, team("lead", { sharedWorkspaces: ["side"] }, "Legacy goal"));
      write(`${TEAMS_DIR}/lead.json`, team("lead", { sharedWorkspaces: ["side"] }, "Requested goal"));
    });

    it("share builds the new orchestrator's prompt from, and returns, the requested file", async () => {
      const { context, created } = host(root, ["lead", "side", "extra"]);
      const result = await shareWorkspace({ projectId: "prj_1", file: `${TEAMS_DIR}/lead.json`, workspaceId: "wks_extra" }, context);
      expect(result).toMatchObject({ ok: true, file: join(root, TEAMS_DIR, "lead.json") });
      expect(created[0]!.config.systemPrompt).toContain("Requested goal");
      expect(created[0]!.config.systemPrompt).not.toContain("Legacy goal");
      // Both files still get the share.
      expect(read(TEAM_FILE).orchestrator.sharedWorkspaces).toEqual(["side", "extra"]);
      expect(read(`${TEAMS_DIR}/lead.json`).orchestrator.sharedWorkspaces).toEqual(["side", "extra"]);
    });

    it("unshare tells the other orchestrators about the requested file", async () => {
      const { context, sent } = host(root, ["lead", "side"], { agents: [agent("orch-lead", "wks_lead", { [LABEL]: "orchestrator" })] });
      const result = await unshareWorkspace({ projectId: "prj_1", file: `${TEAMS_DIR}/lead.json`, workspaceId: "wks_side" }, context);
      expect(result).toMatchObject({ ok: true });
      expect(sent.map((entry) => entry.id)).toEqual(["orch-lead"]);
      expect(sent[0]!.message).toContain(`${TEAMS_DIR}/lead.json`);
      expect(sent[0]!.message).not.toContain(TEAM_FILE);
    });
  });
});

describe("V8 and S20: sub-agent tombstones", () => {
  const boot: ProviderSubagent[] = [{ id: "s1", parentAgentId: "a", parentSubagentId: null, title: "explore", description: null, status: "completed", createdAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-25T00:00:00Z" }];
  const remove = { kind: "remove", parentAgentId: "a", subagentId: "s1" };
  const timeline = { kind: "timeline", parentAgentId: "a", subagentId: "s1", timestamp: "2026-11-25T01:00:00Z" };

  it("a remove for a key that is not live stores a non-running tombstone, which hides the bootstrapped entry", () => {
    const live = applySubagentUpdate({}, remove);
    expect(live).toEqual({ "a:s1": { id: "s1", parentAgentId: "a", parentSubagentId: null, title: null, description: null, status: "completed", createdAt: "", updatedAt: "", removed: true } });
    expect(mergeSubagents(boot, live)).toEqual([]);
  });

  it("a timeline event after a remove of an unknown key does not resurrect it", () => {
    const live = applySubagentUpdate(applySubagentUpdate({}, remove), timeline);
    expect(live["a:s1"]).toMatchObject({ removed: true, status: "completed" });
    expect(Object.values(live).some((entry) => entry.status === "running")).toBe(false);
    expect(mergeSubagents(boot, live)).toEqual([]);
  });

  it("a timeline event after a remove of a live sub-agent does not resurrect it", () => {
    const upserted = applySubagentUpdate({}, { kind: "upsert", subagent: { ...boot[0], status: "running" } });
    const live = applySubagentUpdate(applySubagentUpdate(upserted, remove), timeline);
    expect(mergeSubagents(boot, live)).toEqual([]);
  });

  it("only an upsert brings a tombstoned sub-agent back", () => {
    const removed = applySubagentUpdate(applySubagentUpdate({}, remove), timeline);
    const back = applySubagentUpdate(removed, { kind: "upsert", subagent: { ...boot[0], status: "running" } });
    expect(mergeSubagents(boot, back).map((entry) => [entry.id, entry.status, entry.createdAt])).toEqual([["s1", "running", "2026-11-25T00:00:00Z"]]);
  });

  it("a timeline event for a new sub-agent still starts it as running at its timestamp", () => {
    expect(applySubagentUpdate({}, timeline)["a:s1"]).toMatchObject({ status: "running", createdAt: "2026-11-25T01:00:00Z" });
  });
});

describe("S3: a stored dismissal never hides an agent that needs the user", () => {
  const PARENT = "paseo.parent-agent-id";
  const dash = (id: string, over: Partial<DashboardAgent> = {}): DashboardAgent => ({ id, workspaceId: "wks_a", provider: "claude", model: "m", title: id, status: "idle", archivedAt: null, labels: {}, createdAt: "2026-11-25T00:00:00Z", ...over });
  const roster = [{ orchestratorWorkspaceId: "wks_a", roles: [{ name: "qa", provider: "claude", model: "m", workspaceId: "wks_a" }] }];
  // o1 was archived by Reset session; o2 replaced it; r is o1's qa session.
  const o1 = dash("o1", { labels: { [LABEL]: "orchestrator" }, status: "closed", archivedAt: "2026-11-25T01:00:00Z" });
  const o2 = dash("o2", { labels: { [LABEL]: "orchestrator" }, status: "running", createdAt: "2026-11-25T02:00:00Z" });
  const role = (over: Partial<DashboardAgent>) => dash("r", { labels: { role: "qa", [PARENT]: "o1" }, ...over });
  const asks = role({ status: "running", pendingPermissions: [{ id: "perm" }] });
  const flagged = role({ status: "idle", requiresAttention: true, attentionReason: "permission" });
  const failed = role({ status: "error" });
  const errorFlag = role({ status: "idle", requiresAttention: true, attentionReason: "error" });
  const ids = (nodes: readonly AgentNode[]): string[] => nodes.flatMap((node) => [node.agent.id, ...ids(node.children)]);
  const shown = (forest: AgentForest) => ids([...forest.trees, ...forest.solo]);
  const childrenOf = (forest: AgentForest, id: string) => [...forest.trees, ...forest.solo].find((node) => node.agent.id === id)?.children.map((node) => node.agent.id);

  it("before: with Show closed on, o1 and its closed role session r can be dismissed", () => {
    expect(dismissibleIds(buildAgentForest([o1, o2, role({ status: "closed" })], ["wks_a"], { showClosed: true, roster })).sort()).toEqual(["o1", "r"]);
  });

  for (const [name, r] of [["asks for permission", asks], ["has a permission flag", flagged], ["stops on an error", failed], ["has an error flag", errorFlag]] as const) {
    for (const showClosed of [false, true]) {
      it(`r, continued by o2 after o1 was dismissed, shows under o2 when it ${name} (showClosed ${showClosed}), without a waiting qa stand-in`, () => {
        for (const dismissed of [["o1"], ["o1", "r"]]) {
          const forest = buildAgentForest([o1, o2, r], ["wks_a"], { showClosed, roster, dismissed });
          expect(childrenOf(forest, "o2")).toEqual(["r"]);
          expect(shown(forest)).not.toContain("o1");
          expect(shown(forest).some((id) => id.startsWith("waiting:"))).toBe(false);
        }
      });
    }
  }

  it("r stays hidden while it merely runs or idles (the dismissal still holds)", () => {
    for (const r of [role({ status: "running" }), role({ status: "idle" }), role({ status: "closed" })]) {
      for (const showClosed of [false, true]) {
        expect(shown(buildAgentForest([o1, o2, r], ["wks_a"], { showClosed, roster, dismissed: ["o1"] }))).not.toContain("r");
      }
    }
  });

  it("a dismissed closed agent that later asks for permission or errors is shown again as a solo entry", () => {
    for (const later of [{ status: "running", requiresAttention: true, attentionReason: "permission" }, { status: "running", pendingPermissions: [{ id: "p" }] }, { status: "error" }] as const) {
      for (const showClosed of [false, true]) {
        const forest = buildAgentForest([dash("x", { ...later })], ["wks_a"], { showClosed, dismissed: ["x"] });
        expect(forest.solo.map((node) => node.agent.id)).toEqual(["x"]);
      }
    }
  });

  it("a descendant that needs the user and has no team to adopt it becomes a root; its other dismissed relatives stay hidden", () => {
    const p = dash("p", { status: "closed" });
    const mid = dash("mid", { status: "closed", labels: { [PARENT]: "p" } });
    const leaf = dash("leaf", { status: "running", pendingPermissions: [{ id: "q" }], labels: { [PARENT]: "mid" } });
    const sibling = dash("sib", { status: "running", labels: { [PARENT]: "mid" } });
    for (const showClosed of [false, true]) {
      const forest = buildAgentForest([p, mid, leaf, sibling], ["wks_a"], { showClosed, dismissed: ["p"] });
      expect(shown(forest)).toEqual(["leaf"]);
      expect(forest.solo.map((node) => node.agent.id)).toEqual(["leaf"]);
    }
  });
});
