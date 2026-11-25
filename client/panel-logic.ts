import type { ProviderInfo } from "../shared/validate";

type Effort = { id: string; label: string };

/** Poll every 2 s until the proposal settles; a failed request stops the poll instead of retrying forever. */
export function proposalPollInterval(state: { status: string; data?: { status: string } }): number | false {
  if (state.status === "error") return false;
  return !state.data || state.data.status === "running" ? 2000 : false;
}

/** Provider and model for a blank team's orchestrator: Claude when it is ready, else the first ready provider. */
export function blankOrchestratorModel(catalog: readonly ProviderInfo[]): { provider: string; model: string } {
  const provider = catalog.find((entry) => entry.ready && entry.id === "claude") ?? catalog.find((entry) => entry.ready);
  return { provider: provider?.id ?? "", model: provider?.models[0]?.id ?? "" };
}

/** Efforts to offer in the picker: the model's own, plus a set effort the model does not offer so it can still be cleared. */
export function effortChoices(efforts: readonly Effort[], effort: string | undefined): Effort[] {
  return effort && !efforts.some((option) => option.id === effort) ? [...efforts, { id: effort, label: effort }] : [...efforts];
}

/** The panel's own workspace has no team but another team of the project reserves its title, so nothing can be created here. */
export function reservedByOtherTeam(workspace: string | null, hasTeam: boolean, taken: readonly string[]): boolean {
  if (workspace === null || hasTeam) return false;
  const own = workspace.trim().toLowerCase();
  return taken.some((title) => title.trim().toLowerCase() === own);
}

/** The newer of two mutation results, by when each was submitted; null when neither has one. */
export function latestResult<T>(a: { data: T | undefined; submittedAt: number }, b: { data: T | undefined; submittedAt: number }): T | null {
  if (a.data !== undefined && b.data !== undefined) return a.submittedAt >= b.submittedAt ? a.data : b.data;
  return a.data ?? b.data ?? null;
}

/**
 * Where a tracked planner's poll stands: `waiting` for an answer, `errored` when the request failed before the planner
 * settled (polling has stopped, so nothing is in progress any more), `idle` when nothing is tracked or it has answered.
 */
export function pollPhase(plannerId: string | null, state: { isError: boolean; data?: { status: string } }): "idle" | "waiting" | "errored" {
  if (plannerId === null) return "idle";
  if (state.data && state.data.status !== "running") return "idle";
  return state.isError ? "errored" : "waiting";
}

/** The leftover planner to pick back up, or null: never over a team, a draft, or a proposal start or share that is still in flight. */
export function pendingPickup(agentId: string | null | undefined, busy: { hasTeam: boolean; drafting: boolean; starting: boolean; sharing: boolean }): string | null {
  if (!agentId || busy.hasTeam || busy.drafting || busy.starting || busy.sharing) return null;
  return agentId;
}

/** Advisory lines of an apply, share or restore result; older daemons send none. */
export function noticesOf(result: object | null | undefined): string[] {
  const notices = result && "notices" in result ? result.notices : undefined;
  return Array.isArray(notices) ? notices.filter((line): line is string => typeof line === "string") : [];
}

/** One value per outcome on show: the latest submission among the settled mutations, so a repeated identical result still counts as new. */
export function outcomeToken(mutations: readonly { status: string; submittedAt: number }[]): number {
  return mutations.reduce((latest, mutation) => (mutation.status === "success" || mutation.status === "error" ? Math.max(latest, mutation.submittedAt) : latest), 0);
}
