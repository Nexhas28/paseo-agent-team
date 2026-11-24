import type { Team } from "./team";

/** Paseo's provider snapshot entry (`paseo.providers.snapshot().entries`), as far as validation needs it. */
export interface ProviderEntry {
  provider: string;
  enabled: boolean;
  status: string;
  models?: readonly { id: string; label: string; isSelectable?: boolean; thinkingOptions?: readonly { id: string; label: string }[]; defaultThinkingOptionId?: string }[];
  modes?: readonly { id: string; label?: string; isUnattended?: boolean; colorTier?: string }[];
  defaultModeId?: string | null;
}

export interface ProviderInfo {
  id: string;
  ready: boolean;
  status: string;
  /** `efforts` are the model's thinking options (catalogFrom always sets them; empty when it has none). */
  models: { id: string; label: string; efforts?: { id: string; label: string }[]; defaultEffort?: string }[];
}

export interface TeamError {
  /** "orchestrator" or the role name. */
  target: string;
  message: string;
}

/**
 * The mode new agents start in instead of the provider's default; first match wins: `auto-review`, `auto`, an id or label
 * with a word starting with `auto`, then `isUnattended`, then `dangerous` (claude and codex snapshots carry only `colorTier`).
 * `auto-review` precedes `auto` because Codex's `auto` id is Default Permissions, which prompts, while Claude's `auto`
 * and Codex's `auto-review` both auto-review approvals.
 */
export function agentModeOf(entries: readonly ProviderEntry[], provider: string): string | undefined {
  const modes = entries.find((entry) => entry.provider === provider)?.modes ?? [];
  return (
    modes.find((mode) => mode.id === "auto-review") ??
    modes.find((mode) => mode.id === "auto") ??
    modes.find((mode) => /(^|[^a-z])auto/i.test(mode.id) || /(^|[^a-z])auto/i.test(mode.label ?? "")) ??
    modes.find((mode) => mode.isUnattended === true) ??
    modes.find((mode) => mode.colorTier === "dangerous")
  )?.id;
}

/**
 * The mode a role's agent must be created with: the automatic mode, else the provider's default mode when it is a real mode id,
 * else its first mode. create_agent without a modeId inherits the caller's mode and fails when the role's provider lacks it
 * (opencode has only build/plan and reports "default" as its default). Undefined only when the provider lists no modes.
 */
export function explicitModeOf(entries: readonly ProviderEntry[], provider: string): string | undefined {
  const entry = entries.find((candidate) => candidate.provider === provider);
  const modes = entry?.modes ?? [];
  return agentModeOf(entries, provider) ?? modes.find((mode) => mode.id === entry?.defaultModeId)?.id ?? modes[0]?.id;
}

/** Each role's agent mode, keyed by role name. */
export function roleModes(team: Team, entries: readonly ProviderEntry[]): Record<string, string | undefined> {
  return Object.fromEntries(team.roles.map((role) => [role.name, explicitModeOf(entries, role.provider)]));
}

export type AgentFeatures = { auto_accept: true } | undefined;

/** Use the provider's auto-accept toggle only when no automatic agent mode was found. */
export function agentFeaturesOf(entries: readonly ProviderEntry[], provider: string, features: readonly { id: string; type: string }[]): AgentFeatures {
  return agentModeOf(entries, provider) === undefined && features.some((feature) => feature.id === "auto_accept" && feature.type === "toggle")
    ? { auto_accept: true }
    : undefined;
}

/** The enabled providers and their selectable models with their efforts (thinking options). */
export function catalogFrom(entries: readonly ProviderEntry[]): ProviderInfo[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.provider,
      ready: entry.status === "ready",
      status: entry.status,
      models: (entry.models ?? []).filter((model) => model.isSelectable !== false).map(({ id, label, thinkingOptions, defaultThinkingOptionId }) => ({
        id,
        label,
        efforts: (thinkingOptions ?? []).map((option) => ({ id: option.id, label: option.label })),
        ...(defaultThinkingOptionId ? { defaultEffort: defaultThinkingOptionId } : {}),
      })),
    }));
}

function check(target: string, provider: string, model: string, effort: string | undefined, catalog: readonly ProviderInfo[]): TeamError | null {
  const info = catalog.find((entry) => entry.id === provider);
  if (!info) return { target, message: `provider "${provider}" is not enabled on this host` };
  if (!info.ready) return { target, message: `provider "${provider}" is not ready (${info.status})` };
  const found = info.models.find((entry) => entry.id === model);
  if (!found) return { target, message: `model "${model}" is not available for ${provider}` };
  const efforts = (found.efforts ?? []).map((option) => option.id);
  if (effort !== undefined && !efforts.includes(effort)) {
    return { target, message: `effort "${effort}" is not available for ${provider}/${model} (${efforts.length ? `allowed: ${efforts.join(", ")}` : "it has no effort options; leave it empty"})` };
  }
  return null;
}

/** Checks every provider/model, and effort when set, in the team against what this host can run. */
export function validateTeam(team: Team, catalog: readonly ProviderInfo[]): TeamError[] {
  const errors = [check("orchestrator", team.orchestrator.provider, team.orchestrator.model, team.orchestrator.effort, catalog)];
  for (const role of team.roles) errors.push(check(role.name, role.provider, role.model, role.effort, catalog));
  return errors.filter((error): error is TeamError => error !== null);
}
