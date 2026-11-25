import type { AgentNode } from "../shared/agent-tree";

export type AgentStatusKey = "waiting" | "statusAwaiting" | "statusError" | "statusRunning" | "statusDelegating" | "statusDone" | "statusIdle";

type StatusFields = Pick<AgentNode, "waiting" | "badge" | "live" | "delegating">;

/** The message key of the one status a card shows by glyph, color or animation; what needs the user comes first. */
export function agentStatusKey(node: StatusFields): AgentStatusKey {
  if (node.waiting) return "waiting";
  if (node.badge === "question") return "statusAwaiting";
  if (node.badge === "attention") return "statusError";
  if (node.live || node.badge === "running") return "statusRunning";
  if (node.delegating) return "statusDelegating";
  if (node.badge === "done") return "statusDone";
  return "statusIdle";
}

/** Model, effort and mode as one string, the same text the hover tooltip shows. */
export function agentMeta(node: Pick<AgentNode, "model" | "effort" | "mode">): string {
  return [node.model, node.effort, node.mode].filter(Boolean).join(" · ");
}

export type AgentKindLabel = { key: "kindOrchestrator" | "kindPlanner" | "subagent" } | { key: "kindRole"; role: string } | { provider: string };

/** What a card is, for its accessible name: a message key, or the provider's name for an agent outside the team. */
export function agentKind(node: Pick<AgentNode, "kind" | "role"> & { agent: { provider: string } }): AgentKindLabel {
  if (node.kind === "orchestrator") return { key: "kindOrchestrator" };
  if (node.kind === "planner") return { key: "kindPlanner" };
  if (node.kind === "subagent") return { key: "subagent" };
  if (node.role) return { key: "kindRole", role: node.role };
  return { provider: node.agent.provider };
}
