const titleKey = (title: string) => title.trim().toLowerCase();

type TeamRow = { file: string; workspaceId: string | null; sharedWorkspaces: readonly string[] };
type Workspace = { id: string; title: string };

/**
 * The workspaces a team with a missing home can reconnect to: every workspace no other team uses as its home or shares.
 * The team's own shared workspaces stay in, since reconnecting to one promotes it to home.
 */
export function reconnectChoices<W extends Workspace>(workspaces: readonly W[], teams: readonly TeamRow[], team: TeamRow): W[] {
  const others = teams.filter((entry) => entry.file !== team.file);
  const homes = new Set(others.map((entry) => entry.workspaceId).filter((id) => id !== null));
  const shared = new Set(others.flatMap((entry) => entry.sharedWorkspaces).map(titleKey));
  return workspaces.filter((workspace) => !homes.has(workspace.id) && !shared.has(titleKey(workspace.title)));
}

/** Closed session ids of the projects on screen only; a project that left the list no longer counts. */
export function closedIdsOf(projectIds: readonly string[], closedByProject: Readonly<Record<string, readonly string[]>>): string[] {
  return [...new Set(projectIds.flatMap((id) => closedByProject[id] ?? []))];
}
