import { planWorkspaces, workspaceLabel, type WorkspaceRef } from "./apply-plan";
import type { Team } from "./team";

/** Label key on the agents this plugin starts; the value is the agent's job. */
export const LABEL = "workspace-agents";

/** Label key on a team planner naming the workspace or project its proposal is for, so a reopened screen can find it again. */
export const PROPOSAL_FOR = "workspace-agents-proposal-for";

/** Label key on a team editor or instructions planner naming the workspace or project it works for, so Apply and delete archive only their own. */
export const EDIT_FOR = "workspace-agents-edit-for";

/** The id a team proposal is filed under: the workspace's, or the project's when no workspace is open. */
export function proposalTarget(target: { workspaceId: string } | { projectId: string }): string {
  return "workspaceId" in target ? target.workspaceId : target.projectId;
}

/** The unarchived team planners proposing for the target, newest first. */
export function pendingPlanners(agents: readonly (AgentRef & { createdAt: string })[], targetId: string): string[] {
  return agents
    .filter((agent) => agent.labels[LABEL] === "planner" && agent.labels[PROPOSAL_FOR] === targetId && !agent.archivedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((agent) => agent.id);
}

/** Title of the workspace the planner gets when its project has none. */
export const PLANNER_WORKSPACE = "Team planner";

/** The part of a Paseo agent that cleanup needs. */
export interface AgentRef {
  id: string;
  workspaceId?: string | null;
  labels: Record<string, string>;
  archivedAt?: string | null;
}

/**
 * What to archive once a team is applied: the unarchived planners working for `scope` (the applied target and the team's
 * workspace ids), an old planner without a target label in one of those workspaces, and a Team planner workspace the team
 * doesn't use and that has no other agents left. Planners for other workspaces or the project keep running.
 */
export function plannerCleanup(workspaces: readonly WorkspaceRef[], agents: readonly AgentRef[], team: Team, scope: readonly string[]): { agents: string[]; workspaces: string[] } {
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  const targets = new Set(scope);
  const live = agents.filter((agent) => ids.has(agent.workspaceId ?? "") && !agent.archivedAt);
  const mine = (agent: AgentRef) => {
    const target = agent.labels[PROPOSAL_FOR] ?? agent.labels[EDIT_FOR];
    return target === undefined ? targets.has(agent.workspaceId ?? "") : targets.has(target);
  };
  const planners = live.filter((agent) => agent.labels[LABEL] === "planner" && mine(agent));
  const emptied = workspaces.filter(
    (workspace) =>
      workspaceLabel(workspace) === PLANNER_WORKSPACE &&
      planWorkspaces(team, [workspace]).every((step) => step.existingId === null) &&
      live.every((agent) => agent.workspaceId !== workspace.id || planners.includes(agent)),
  );
  return { agents: planners.map((agent) => agent.id), workspaces: emptied.map((workspace) => workspace.id) };
}

/** An agent as orchestrator reuse needs it. */
export interface OrchestratorCandidate extends AgentRef {
  provider: string;
  model: string | null;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
}

/**
 * The running orchestrator in the lead workspace on the team's provider/model, effort and, when given, mode.
 * `defaultEffort` is the model's default thinking option, so an unset team effort matches an agent on the model default.
 * Without a model default, an unset team effort matches an agent started without one, whatever effective value it reports
 * (OpenCode reports "default", Pi "off").
 */
export function findOrchestrator(agents: readonly OrchestratorCandidate[], workspaceId: string, team: Team, modeId: string | undefined, defaultEffort?: string): OrchestratorCandidate | undefined {
  const effort = team.orchestrator.effort ?? defaultEffort;
  const sameEffort = (agent: OrchestratorCandidate) =>
    effort === undefined ? !agent.thinkingOptionId : (agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? defaultEffort) === effort;
  return agents.find(
    (agent) =>
      agent.workspaceId === workspaceId &&
      agent.labels[LABEL] === "orchestrator" &&
      !agent.archivedAt &&
      agent.provider === team.orchestrator.provider &&
      agent.model === team.orchestrator.model &&
      sameEffort(agent) &&
      (modeId === undefined || agent.currentModeId === modeId),
  );
}

/** The unarchived orchestrators of the workspace, whatever their provider, model or mode; a restart archives them all. */
export function orchestratorsToArchive(agents: readonly AgentRef[], workspaceId: string): string[] {
  return agents.filter((agent) => agent.workspaceId === workspaceId && agent.labels[LABEL] === "orchestrator" && !agent.archivedAt).map((agent) => agent.id);
}

/** What a deleted team leaves to archive: its orchestrators and labelled roles in its workspaces, and planners proposing or editing for them anywhere. */
export function teamAgentsToArchive(agents: readonly AgentRef[], workspaceIds: readonly string[], roles: readonly string[]): string[] {
  const names = new Set(roles.map((role) => role.toLowerCase()));
  return agents
    .filter((agent) => !agent.archivedAt && ((workspaceIds.includes(agent.workspaceId ?? "") && (agent.labels[LABEL] === "orchestrator" || names.has((agent.labels.role ?? "").toLowerCase()))) || (agent.labels[LABEL] === "planner" && workspaceIds.includes(agent.labels[PROPOSAL_FOR] ?? agent.labels[EDIT_FOR] ?? ""))))
    .map((agent) => agent.id);
}
