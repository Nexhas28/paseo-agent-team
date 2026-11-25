# Follow-ups

## Code review 2026-11-25

Scope: index.server.ts, index.client.tsx, server/, shared/, client/ (all files read in full). `npm run typecheck` passes; i18n keys and `{{placeholders}}` match across en/ko/ja/zh (checked by script). Known open items not repeated here: pagination (fu-47de9e53039d), relative vs absolute `file` in `team.projects` vs `team.apply`/`team.share`/`team.restore` (fu-64d8c26f699a), per-agent timeline reads in the dashboard (fu-5355074dacb2), narrow-sidebar overflow (fu-14efcc321792), dashboard state lost on leaving the screen (fu-df3401582691), planner not read-only (fu-e0953b53000b).

- **R1** · medium · fixer · `server/team.ts:174` (`projectTeams`, also `:161`) · confirmed
  Failure: any entry under `.agents/teams/*.json` that can't be read (a directory named `x.json`, a dangling symlink, or a file deleted between `readdir` and `readFile`) throws out of `projectTeams`. `projectTeamsList` uses `Promise.all` over all projects, so the whole Agent teams screen shows one error and no project at all; `team.read`, `team.roster`, apply, delete, share for that project also throw. Reproduced with a fake `paseo` and `/tmp/rv/p1/.agents/teams/broken.json/` → `REJECTED: EISDIR` even though the second project was valid.
  Fix: catch per file in `projectTeams` and push `${file}: ${error}` into `errors` (like parse errors); in `projectTeamsList` also isolate per project (`Promise.allSettled` or try/catch → project with `errors`).

- **R2** · medium · fixer · `shared/cleanup.ts:41` (`plannerCleanup`), called from `server/team.ts:466` · confirmed
  Failure: Apply (and Restore) archives every unarchived `planner` in all workspaces of the project, including ones still working for another target. Workspace A applies while workspace B's panel is waiting on its own team proposal, an "Edit team with AI" run, or an "Improve with AI" run → B's planner is archived mid-run; B's poll then errors or never finishes and its proposal is lost. Script: `plannerCleanup(ws, [plannerFor wB, instructions planner in wB], teamA)` → archives both. README says cleanup archives "every planner left in the project", but not that it kills in-flight work for other workspaces.
  Fix: archive only planners whose `PROPOSAL_FOR` is the applied target (or the team's home/shared workspace ids or the project id) plus finished planners; give edit/instructions planners a `PROPOSAL_FOR` label too so they can be scoped.

- **R3** · medium · ui · `client/TeamPanel.tsx:603-611` (`applied` mutation) · confirmed
  Failure: after a successful Apply in the workspace panel, `draft` (and `plannerId`, edit history) are never cleared. The panel keeps showing "Review the proposal" with an enabled Apply, and the current-team card with Apply again / Reset session / Unshare is hidden (`data.team && !draft`) until the user presses Cancel, which reads like discarding the team that was just applied. (TeamScreen hides this by navigating away in `onApplied`.)
  Fix: on `result.ok` clear `draft`, `plannerId`, edit state and history (same reset as Cancel, without calling `cancelProposal`); keep the "Applied" result card.

- **R4** · medium · fixer + ui · `server/team.ts:281` and `:299-304`; `client/TeamPanel.tsx:552-558` (`cancelTeamEdit`), `:318-323` (`InstructionsDialog.close`) · confirmed
  Failure: "Team editor" and "Instructions planner" agents are left running/unarchived. `teamEditProposal` archives only on a parsed `done`; on `failed` it stays. `instructionsProposal` never archives, even on success. Cancel in the progress modal or closing the instructions dialog only forgets the agent id, so the planner keeps running and spending tokens. Neither has `PROPOSAL_FOR`, so `team.proposal.cancel` and `team.delete` never reach them; only a later Apply (R2) does, and Cancel of the draft without Apply leaks them for good. They also show up as planner cards in the dashboard.
  Fix: server archives the agent on any terminal status (`done`/`failed`) in both proposal handlers; add a cancel RPC (or extend `team.proposal.cancel`) that archives a given planner id, and call it from `cancelTeamEdit` and `InstructionsDialog.close` when a planner is in flight.

- **R5** · low · ui · `client/TeamPanel.tsx:137` (`EffortPicker`) · confirmed
  Failure: a role or orchestrator with `effort` set on a model that has no thinking options (team file edited by hand, or a planner answer) gets the validation error "it has no effort options; leave it empty", but the picker returns `null` for such models, so there is no control to clear it and Apply stays disabled. The only escape is switching to another model and back (`withModel` drops the key).
  Fix: when `efforts` is empty but `effort` is set, render the picker (or a "clear" button) with just the Default option.

- **R6** · low · fixer · `server/team.ts:443` with `shared/team-files.ts:93`, `:107` · confirmed
  Failure: `applyTeam` excludes the team whose home equals the draft's home from the clash check and `teamFileFor` reuses that team's file, so applying a new team from a project target (Agent teams screen → New team) whose orchestrator workspace equals an existing team's home overwrites that team's file and roles. Only the client check (`takenWorkspaces`) prevents it, which is stale if a team was created elsewhere after the screen loaded. Script: `workspaceClashes(team, workspacesOfOtherTeams([teamAtA], "A"))` → `[]`, file → `.agents/teams/a.json`.
  Fix: for a `{ projectId }` target (and for a workspace target whose title isn't the home or a shared workspace), refuse when `teamAtHome(teams, home)` already exists, or require the caller to pass the file it is editing.

- **R7** · low · fixer · `server/team.ts:369-378`, `shared/cleanup.ts:64-75` · confirmed (effort sub-case suspected)
  Failure: when the running orchestrator's provider/model, current mode or effort differs from the team (orchestrator model changed in the editor, or the user switched its mode in Paseo), Apply / Apply again starts a second orchestrator and leaves the old one unarchived with the same `orchestrator` label. Later applies from other workspaces `send` "team changed" to both (`notifyOrchestrators` → `orchestratorsToArchive`), so two orchestrators can delegate to the same role sessions. Suspected extra case: a model without `defaultThinkingOptionId` whose agent reports an `effectiveThinkingOptionId` never matches an unset team effort, so every Apply again adds an orchestrator. Confirm with a provider snapshot that has thinking options but no default.
  Fix: when no match is found, archive the workspace's other orchestrators (as `restartOrchestrator` does) before starting the new one, or report them in `cleanup`; compare effort with the agent's value only when the team sets one.

- **R8** · low · fixer · `server/team.ts:193` vs `:402` · confirmed
  Failure: in a workspace that is only an old role workspace of a legacy team file, `readTeam` uses `workspaceOwnerOf` (includes `legacyWorkspaces`) and shows that team with Edit / Apply again / Reset session, but `restartOrchestrator` uses `teamIn` (home and shared only), so Reset session fails with "No team was found for the target workspace." The panel also presents the team as if it ran there.
  Fix: in `readTeam` show a team only through `teamIn`, and treat a legacy-only reservation as "taken by another team" (it's already in `takenWorkspaces` through `teamFileWorkspaces`).

- **R9** · low · ui · `client/TeamPanel.tsx:275` and `:316`, same pattern at `:534`, `:563` · confirmed (trigger suspected)
  Failure: the `refetchInterval` callbacks return 2000 whenever `query.state.data` is undefined, so after an RPC error (for example, the planner was archived by R2) the query keeps polling every 2 s forever. In `InstructionsDialog`, `busy` stays true (`plannerId !== null && status !== "failed"`), so "Improve with AI" stays disabled until the dialog is closed. Confirm by archiving an instructions planner while the dialog polls.
  Fix: stop polling when `query.state.error` is set (`return query.state.status === "error" ? false : …`) and treat an error as not busy.

- **R10** · low · ui · `client/TeamPanel.tsx:893` ("Start with an empty team") · confirmed
  Failure: the blank draft hard-codes `provider: "claude"` for the orchestrator. On a host where Claude is disabled or not ready, the draft immediately shows `orchestrator: provider "claude" is not enabled…`, and the model is `""`. Roles already use the first ready provider (`newRole`).
  Fix: pick the orchestrator like `newRole` does (Claude when ready, else the first ready provider and its first model).

- **R11** · low · ui · `client/TeamPanel.tsx:540-541` (`fresh`) · confirmed
  Failure: from the Agent teams screen (project target), `withFreeWorkspaces` avoids only existing workspace titles (`projectWorkspaces`), not homes of teams whose workspace is missing (`takenWorkspaces`). A project with a team file for missing workspace "orchestrator" gets a proposed draft with workspace "orchestrator" that immediately fails with "workspace "orchestrator" belongs to another team".
  Fix: pass `[...projectWorkspaces, ...takenWorkspaces]` to `withFreeWorkspaces`.

- **R12** · low · fixer · `shared/messages.ts:42` (`screen.roles`) · confirmed
  Failure: English has no plural forms for `screen.roles`, so a one-role team shows "1 roles" (Agent teams rows and the copy list in `TeamPanel.tsx:907`).
  Fix: add `roles_one: "{{count}} role"` / `roles_other` in `en` (and `_other` in ko/ja/zh), keep the placeholder identical.

### Accessibility and keyboard (for the UI redesign)

- **R13** · medium · ui · `client/AgentDashboard.tsx:722`, `:735` (card `accessibilityLabel`), `:124-189` (`Badge`) · confirmed
  Failure: a dashboard card exposes only its title to assistive tech. Status (running, delegating, waiting for an answer "?", error "!", done "✓", Waiting role), kind (orchestrator/role/sub-agent) and model are conveyed only by glyphs, color (red/amber border) and animation, so a screen-reader user can't find the agent that needs an answer.
  Fix: build the label from kind/role, title, status and model (e.g. "ui#ADB2, role ui, waiting for your answer"), mark the badge as not accessible, and use `accessibilityState={{ busy: live }}`.

- **R14** · medium · ui · `client/AgentDashboard.tsx:1359-1401` (packet/glow/flow loops), `:741-818` (live card), `:829` (`Dashes`) · confirmed
  Failure: the dashboard's looping animations ignore the OS reduce-motion setting (the sidebar badge and tooltip honour it) and run even when no agent is live, so they keep moving for users who asked for reduced motion and keep the JS loop busy on web.
  Fix: read `AccessibilityInfo.isReduceMotionEnabled` once in `useDashboardData` and skip or stop the loops (static red border instead of glow, packets and dashes); also start them only when some node is live.

- **R15** · low · ui · `client/AgentDashboard.tsx:322-329`, `:724-726` · confirmed
  Failure: the full title/model tooltip appears only on mouse hover after 1 s (web). Titles are truncated to one line (Brief cuts to ~11 characters), and keyboard and touch users can't read the full text.
  Fix: also show the tooltip on focus (`onFocus`/`onBlur`), or keep the full text in the accessibility label (R13) and add a long-press preview on native.

- **R16** · low · ui · `client/AgentDashboard.tsx:690-716`, `:719-739` · confirmed
  Failure: the hide "×" and "Archive" Pressables are nested inside the card Pressable (role button inside role button on web), so screen readers merge or skip them. The × target is 16×16 px with no `hitSlop`.
  Fix: render them as siblings of the card in a wrapper View, and give the × a `hitSlop` of at least 8 and a label naming the agent.

- **R17** · low · ui · `client/TeamPanel.tsx:175`, `:191`, `:336`, `:360`, `:801`, `:890`, `:960` · confirmed
  Failure: the role name, folders, instructions, improve-request, picker search, goal and team-edit-request `TextInput`s have no `accessibilityLabel`; most rely on the placeholder, which disappears once text is typed, so a screen reader announces only the value.
  Fix: set `accessibilityLabel` from the same `t(...)` key as the visible label or placeholder.

- **R18** · low · ui · `client/TeamScreen.tsx:286-292`, `client/TeamPanel.tsx:184`, `:214`, `:912-913` · confirmed
  Failure: repeated buttons have identical labels on every row ("Open team", "Reconnect", "Delete", "Remove", "Edit instructions", "Copy", "Share"), so in a screen reader's control list they can't be told apart.
  Fix: add the team's workspace or the role name to `accessibilityLabel` (needs new i18n keys with placeholders in all four languages).

- **R19** · low · ui · `client/TeamScreen.tsx:352-383` (tabs, filters), `client/AgentDashboard.tsx:1514` (density), `client/TeamPanel.tsx:846-865` (picker) · confirmed
  Failure: the Teams / All agents tabs, the activity filters and the density toggle are announced as plain buttons rather than tabs or a radio group. In the picker, ArrowUp/ArrowDown move a visual highlight that is never exposed to assistive tech, so the option a keyboard user picks with Enter is not announced.
  Fix: use `accessibilityRole="tab"` (in a `tablist`) and `"radio"` with `checked`; for the picker, give the highlighted row focus or expose it as the active descendant on web.

- **R20** · low · ui · `client/TeamPanel.tsx:986`, `:995-1000`; `client/TeamScreen.tsx:305-308` · confirmed
  Failure: Apply/restart/share errors and the "Applied" result render at the bottom of a long ScrollView with no live region, so after pressing Apply nothing is announced and the message is often off-screen.
  Fix: add `accessibilityLiveRegion="polite"` (and `role="alert"` on web) to error and result containers, and scroll them into view.

- **R21** · low · ui · `client/AgentDashboard.tsx:366` (id suffix), `:688` (waiting 0.45 / sub-agent 0.85 opacity) · confirmed
  Failure: Waiting cards at 45% opacity and the `#ABCD` suffix at 55% alpha of `foregroundMuted` fall well below WCAG text contrast on both themes.
  Fix: dim the border, background or logo instead of the text, or keep text at ≥ 4.5:1 against `surface1`.

- **R22** · low · ui · `client/TeamScreen.tsx:76`, `:107-113` · suspected
  Failure: the awaiting count's label sits on a non-`accessible` View inside `SidebarRow`'s pressable, so the row is likely announced as just "Agent teams" without "N agents waiting for your answer". Confirm with VoiceOver or the web accessibility tree.
  Fix: pass the count into the row's own accessibility label (if `SidebarRow` allows it) or mark the badge View `accessible`.

### Second pass 2026-11-25

- **S1** · high · ui · `client/TeamPanel.tsx:530-544` (`planning` query and `useEffect`) · confirmed
  Failure: When a team proposal finishes (`planning.data.status === "done"`), `plannerId` is never cleared and there is no already-applied guard (unlike `editPlanning`, which tracks `appliedEditId` at `:493` and clears `editPlannerId` at `:598`). Because `planning` stays `enabled: plannerId !== null` with TanStack Query's default `refetchOnWindowFocus: true` and `staleTime: 0`, any background refetch (for example switching windows and returning to Paseo while reviewing/editing the proposed draft) returns a fresh `planning.data` object, re-fires the effect at `:542-544`, and runs `resetEditHistory(); cancelTeamEdit(); setDraft(fresh(planning.data.team))` — silently wiping all manual edits, AI edits, undo/redo history, and any in-flight AI edit back to the original proposal.
  Fix: Guard against re-applying the same `plannerId` with a ref (like `appliedEditId`) and stop polling/refetching once `done` (e.g. clear `plannerId` while keeping the pending proposal id separately for Cancel, or disable refetching once applied).

- **S2** · high · fixer · `shared/cleanup.ts:38-49` (`plannerCleanup`), `server/team.ts:314-321`, `:452-466` (`archivePlanners`, `applyTeam`) · confirmed
  Failure: `plannerCleanup` only exempts workspaces matching `planWorkspaces(team, [workspace])` (which checks `team.orchestrator.workspace` only, ignoring `team.orchestrator.sharedWorkspaces` and other teams in the project), and `applyTeam` fetches `agents` at `:463` before `runOrchestrator` at `:464` creates the new orchestrator. If a team shares a workspace titled `"Team planner"` (or another team's home is `"Team planner"` with no live non-planner agents, e.g. `.agents/teams/team-planner.json`), applying from `"Team planner"` starts the new orchestrator there and then `plannerCleanup` immediately marks `"Team planner"` as emptied and archives it. Reproduced directly against `applyTeam`: `{ ok: true, createdAgents: [{ ws: "w_tp", title: "Orchestrator" }], archivedWs: ["w_tp"] }`. Also, `archivePlanners` (`:315-319`) archives `"Team planner"` even when archiving a planner agent inside it failed.
  Fix: Exclude every workspace belonging to any team in the project (`teams.flatMap(teamFileWorkspaces)` plus `teamWorkspaces(team)`) and `lead.id` from `emptied`, and skip archiving a workspace in `archivePlanners` if archiving any planner agent inside that workspace failed.

- **S3** · high · fixer · `shared/agent-tree.ts:73-76`, `:197`, `:240-256` (`canDismiss`, `agentNode`, `buildAgentForest`) · confirmed
  Failure: `canDismiss` only checks `!node.live && !node.delegating`, where `delegating` (`:197`) is true only when a descendant has `status === "running"`. An archived or closed parent whose unarchived child is stopped on an error (`badge: "attention"`), waiting on a permission with non-running status (`badge: "question"`), or `status: "idle"` still has `canDismiss(parent) === true` and is included by `dismissibleIds`. Clicking "Hide closed" (or `×` on the parent) adds `parent.id` to `dismissed`; `buildAgentForest` (`:241-255`) recursively adds all descendants of `parent.id` to `dismissed` and drops them at `:256` even after `showClosed` is toggled back off (when `ClosedControls` hides "Restore hidden" at `client/AgentDashboard.tsx:1594`) and even if that child later resumes `status: "running"`. Reproduced with `[archivedParent, errChild, permChild]`: `dismissibleIds` returned `["p"]` and `buildAgentForest(..., { showClosed: false, dismissed: ["p"] })` returned `{ trees: [], solo: [] }`, hiding both unarchived error and permission-waiting agents.
  Fix: Return `false` from `canDismiss` whenever any descendant is not dismissible (unarchived idle, `attention`, `question`, or `live`), and do not cascade a dismissed parent's exclusion in `buildAgentForest` to non-hidden/active descendants (let them promote or be adopted instead).

- **S4** · high · fixer · `server/team.ts:439-441` (`applyTeam`) · confirmed
  Failure: `applyTeam` only preserves the file's `sharedWorkspaces` when `checked.team.orchestrator.sharedWorkspaces === undefined`. When a user opens Edit on a shared team (`draft` carries `sharedWorkspaces: ["Team planner"]`), and another workspace (`"extra"`) is shared — or `"Team planner"` is unshared — before Apply is clicked, `checked.team.orchestrator.sharedWorkspaces` is defined and overwrites the file on disk with the stale list, silently dropping `"extra"` (leaving its orchestrator running) or re-adding an unshared workspace (or failing with a workspace clash if another team took it). Reproduced against `applyTeam`: disk had `["Team planner", "extra"]`, applying the stale draft overwrote it to `["Team planner"]`.
  Fix: Since only `shareWorkspace` and `unshareWorkspace` change `sharedWorkspaces` (comment at `:439`), always preserve `previous` from disk (`previous?.length ? { sharedWorkspaces: previous }` else omit the key) when updating an existing team in `applyTeam`.

- **S5** · medium · ui · `client/TeamPanel.tsx:627-634`, `:729-740` (`unshared` mutation and confirmation box) · confirmed
  Failure: When `unshareWorkspace` succeeds with archive or notification failures (`{ ok: true, failures: [...] }`), `unshared.onSuccess` (`:630-632`) immediately calls `setConfirmUnshare(false)` and `refreshTeams()` (which sets `data.team = null` and `sharedHere = false`). The failure rendering at `:738` (`unshared.data?.ok && unshared.data.failures.length`) sits inside `{data.team && !draft}` and `{sharedHere && confirmUnshare}`, so it immediately unmounts and is dead code; unshare failures are never shown to the user (and could appear stale if re-shared later).
  Fix: Render `unshared` failures outside `{data.team && !draft}` / `confirmUnshare` (alongside `applied`/`restarted` results at `:995-1000` or via toast), and reset `unshared` when sharing.

- **S6** · medium · ui · `client/TeamScreen.tsx:263-269` (`reconnectWorkspaces`) · confirmed
  Failure: `reconnectTeam` (`server/team.ts:132-134`) explicitly calls `unshareTeam(..., title)` so a team whose home workspace was deleted or renamed can reconnect to one of its own `sharedWorkspaces` (promoting it to home). However, `TeamScreen.tsx:264-269` computes `sharedTitles` across *all* `project.teams` once per project instead of per team, filtering out the reconnecting team's own shared workspaces. If the team's home is missing and no unrelated unused workspace exists, `reconnectWorkspaces` is empty and the UI shows `"This project has no workspace to pick."`, preventing promotion of its shared workspace.
  Fix: Compute `reconnectWorkspaces` per team row, excluding only other teams' home and shared workspaces (matching `workspacesOfOtherTeams` in `server/team.ts:132`).

- **S7** · medium · ui · `client/TeamPanel.tsx:522-527`, `:602`, `:892-893`, `:912-913` (`pending` effect and `start` mutation) · confirmed
  Failure: Two races can overwrite an active draft. First, `pending` (`:523`) runs whenever `current.data !== undefined` — even when `data.team !== null` or after the user clicked "Start with an empty team", "Copy", or "Edit" — and `:526` sets `plannerId` whenever `plannerId === null`; a late or refetched `pending.data` with a leftover unarchived planner activates `planning` and overwrites the user's draft (or hides an existing team). Second, `start` (`:602`) lacks a cancellation counter (unlike `startTeamEdit` and `startImprove`) and does not disable Blank/Copy/Share while `start.isPending`; clicking Blank or Copy while `propose` is in flight lets `start.onSuccess` hijack `plannerId` and overwrite the draft.
  Fix: Disable `pending` when `current.data?.team` is present, ignore `pending.data` once `draft !== null` (and clear `pendingKey` on Blank/Copy/Edit/Apply), and guard `start` with a request counter (reset on Blank/Copy/Edit/Cancel) while disabling competing create buttons during `start.isPending`.

- **S8** · medium · ui · `client/AgentDashboard.tsx:311`, `:335-362`, `:1162-1170` (`Card` `subagentPill` with `collapseRoot`) · confirmed
  Failure: In `brief` density (`collapseSubagents: true`), `Tree` hides a root agent's provider sub-agents until `expandedSubagents[node.agent.id]` is toggled. When the panel is narrow enough for `collapseRoot` to be true (common in the Explorer sidebar panel where `panelWidth - (pad + TREE_PAD_X) * 2 < widestTree`), `Card` sets `collapsed = true` (`:311`) and suppresses `subagentPill` (`!collapsed && ...` at `:336`). The root's sub-agents remain hidden with no `+N` pill and no way to expand them.
  Fix: Render `subagentPill` on collapsed root cards as well (or do not collapse sub-agents on a node whose toggle pill is hidden).

- **S9** · medium · ui · `client/TeamScreen.tsx:20-26`, `:141-145` (`useProjectTeams`) · confirmed
  Failure: `useProjectTeams` subscribes only to `paseo.projects`, never `paseo.workspaces` (and `useDashboardData` at `client/AgentDashboard.tsx:1421-1424` invalidates only `["dashboard", "workspaces"]` and `["dashboard", "roster"]`, not `PROJECT_TEAMS_KEY`). When a workspace is created, renamed, or archived while `TeamScreen` is open or cached, `project.workspaces` and each team's `workspaceId` stay stale: agents started in a newly created workspace never appear in the "All agents" tab (which filters by `project.workspaces` at `:142-144`), and the "Teams" tab shows stale "Open team" / "workspace not found" state and reconnect options.
  Fix: Subscribe to `paseo.workspaces.subscribe(...)` (coalesced) in `useProjectTeams` to invalidate `PROJECT_TEAMS_KEY`.

- **S10** · medium · ui · `client/TeamScreen.tsx:111`, `:125`, `:136-139`, `:218-233` (`TeamScreen` `projectId` vs sidebar badge navigation) · confirmed
  Failure: While the user is inside the "New team" view on `TeamScreen` (`projectId !== null`), clicking the sidebar row's awaiting-response badge opens the screen with `{ tab: "agents", filter: "awaiting", at: ... }` (`:111`). The effect at `:136-139` sets `tab` and `activityFilter` but never clears `projectId`, so the early return `if (projectId)` at `:218` keeps the user stuck on `<TeamEditor />` instead of switching to the "All agents" tab.
  Fix: Call `setProjectId(null)` in the `params` effect when navigating to the agents tab (`params?.tab === "agents"` or when `params?.at` changes).

- **S11** · medium · fixer · `server/team.ts:381-393`, `:464-465` (`notifyOrchestrators`, `applyTeam`) · confirmed
  Failure: When a team shared across multiple workspaces is edited to change the orchestrator's `provider`, `model`, or `effort` and applied from one workspace, `runOrchestrator` starts an orchestrator on the new config in the applied workspace, while `notifyOrchestrators` only sends `teamChangedMessage` to existing orchestrators in the team's other workspaces (home or other shared workspaces). Those other workspaces stay permanently on the old orchestrator provider, model, or effort.
  Fix: In `notifyOrchestrators`, check whether each workspace's running orchestrator matches the updated team via `findOrchestrator`; send `teamChangedMessage` only when it matches, and otherwise archive and restart it on the new provider/model/effort (reporting errors in `cleanup`).

- **S12** · medium · fixer · `server/team.ts:82-89`, `:147-153`, `:422-428`, `:447-450`, `:473-491`, `:498-515` (duplicate team files for the same home workspace) · confirmed
  Failure: When both a legacy `.agents/team.json` and `.agents/teams/<ws>.json` exist for the same `orchestrator.workspace` (supported by `sameTeamFiles` and tested in `tests/delete-team.test.ts` and `tests/reconnect-team.test.ts`), the other handlers diverge: `projectTeamsList` lists both as duplicate team rows; `teamRoster` emits duplicate entries for every workspace (reproduced: 4 entries for 2 workspaces; `waitingRoles` at `shared/agent-tree.ts:223` keeps the last file while `readTeam`/`teamIn` picks the first); `applyTeam` rewrites only `teamFileFor` (`.agents/team.json`), leaving `.agents/teams/<ws>.json` stale; `restoreTeam` on `.agents/teams/<ws>.json` overwrites `.agents/team.json` instead (reproduced); and `shareWorkspace`/`unshareWorkspace` validate and notify using `own[0]` instead of the requested `file`.
  Fix: Deduplicate by home workspace (matching `otherTeams`/`teamAtHome`) in `projectTeamsList` and `teamRoster` (or report a duplicate-file error), update every file in `sameTeamFiles` on `applyTeam`, and use the requested `file`'s entry (not `own[0]`) in `shareWorkspace`/`unshareWorkspace`.

- **S13** · medium · fixer · `shared/team.ts:12-20`, `:38-46` (`OrchestratorSchema`, `TeamSchema`), `server/team.ts:503` (`unshareWorkspace`) · confirmed
  Failure: `TeamSchema` accepts a hand-edited team file whose `orchestrator.sharedWorkspaces` contains duplicates (`["side", "SIDE"]`) or repeats `orchestrator.workspace` itself (`workspace: "lead", sharedWorkspaces: ["lead"]`). Reproduced via `parseTeam` → `{ ok: true }`. This causes `teamWorkspaces` to return duplicates, emitting duplicate `teamRoster` entries, sending duplicate `teamChangedMessage` prompts in `notifyOrchestrators`, inflating the workspace count in `client/TeamPanel.tsx:720` (`sharedWorkspaces.length + 1`), and allowing `unshareWorkspace` (`server/team.ts:503`, which lacks the `isHome` check that `shareWorkspace` has at `:478`) to archive the home workspace's orchestrator.
  Fix: Reject case-insensitive duplicates and `orchestrator.workspace` in `sharedWorkspaces` inside `TeamSchema.superRefine`, and reject `isHome` in `unshareWorkspace`.

- **S14** · medium · ui · `client/TeamPanel.tsx:460-465` (`TeamPanel` / `TeamEditor`) · suspected
  Failure: `TeamPanel` renders `<TeamEditor {...props} target={{ workspaceId }} />` without `key={workspaceId}`, and `TeamEditor` never resets local state (`draft`, `plannerId`, `history`, `editNotice`, `editPlannerId`, `goal`, `applied`, `shared`, `unshared`, `restarted`, open modals) when `target` changes. If Paseo reuses a mounted panel instance when switching workspaces (updating `workspaceId` without unmounting), Workspace A's open draft, pending proposal, or "Applied · Open orchestrator" card leaks into Workspace B, letting the user apply Workspace A's draft from Workspace B or open the wrong orchestrator. Confirm by switching between two workspaces in Paseo while `TeamPanel` has an open draft or an "Applied" card and checking whether the component remounts.
  Fix: Pass `key={workspaceId}` to `<TeamEditor />` in `TeamPanel` (and `key={projectId}` in `TeamScreen`), or reset local state and mutations when `target` changes.

- **S15** · medium · fixer · `shared/proposal.ts:58-68` (`jsonIn`) · confirmed
  Failure: `jsonIn` extracts JSON by slicing from the first `{` to the last `}` in the planner's answer (`indexOf("{")` .. `lastIndexOf("}")`). Any surrounding prose containing braces — such as `{role}`, `${var}`, or a short inline JSON snippet before/after a ```` ```json ```` block — makes `JSON.parse` fail even when the fenced JSON block is valid. Reproduced: `extractInstructions('Updated {role} prompt:\n```json\n{"instructions":"Run tests."}\n```')` returned `{ ok: false, errors: ["the planner's answer is not valid JSON: ..."] }`.
  Fix: Check fenced code blocks (```` ```json ... ``` ```` / ```` ``` ... ``` ````) first, then scan balanced `{ ... }` objects before falling back to `indexOf("{")` / `lastIndexOf("}")`.

- **S16** · low · ui · `client/TeamScreen.tsx:130`, `:166`, `:343` (`closedByProject` / `closedIds`) · confirmed
  Failure: `closedIds` aggregates `Object.values(closedByProject).flat()` across every project id ever recorded in `closedByProject`. When a project leaves `agentSections` (for instance, its agents are removed or hidden), its `AgentDashboardView` unmounts without clearing `closedByProject[project.id]`, leaving stale ids in `closedIds` that inflate `Hide closed ({{count}})` and get added to `dashState.dismissed`.
  Fix: Derive `closedIds` only from active `agentSections` (`agentSections.flatMap(({ project }) => closedByProject[project.id] ?? [])`), matching `counts` at `:146`.

- **S17** · low · ui · `client/TeamScreen.tsx:141-145` (`agentSections`) · confirmed
  Failure: When `dashState.showClosed` is `false`, `agentSections` checks `!agent.archivedAt` instead of `!isHidden(agent)` (`shared/agent-tree.ts:68-70`). A project whose only agent has `status: "closed"` and `archivedAt: null` stays in `agentSections`, so `AgentDashboardView` builds an empty forest (`showClosed: false` filters `isHidden`) and renders an empty project card saying `"No agents in this project yet."` in the "All agents" tab.
  Fix: Filter `agentSections` with `dashState.showClosed || !isHidden(agent)`.

- **S18** · low · ui · `client/TeamPanel.tsx:620-626`, `:918-920` (`shared` mutation) · confirmed
  Failure: In `TeamPanel` (where `onApplied` is omitted), `shareWorkspace` returns `teamApplyRpc.output` (`cleanup`, `permission`, `orchestratorAgentId`), but `TeamPanel` only displays `shared.data.errors` on failure (`:920`) and drops `shared.data.cleanup` (orchestrator notification failures) and `shared.data.permission` (added `.claude/settings.local.json` rule) when `result.ok` is true.
  Fix: Render `shared.data.cleanup`, `shared.data.permission`, and "Open orchestrator" when `shared.data?.ok` (matching `applied.data?.ok` at `:1001-1011`), or surface them via toast.

- **S19** · low · ui · `client/TeamScreen.tsx:148-154`, `:392`, `:397-403` (`shownSections` / `hiddenSections`) · confirmed
  Failure: `shownSections` renders `AgentDashboardView` inside the column grid while `hiddenSections` renders it inside a separate `<View style={{ display: "none" }}>`. Whenever a project transitions between hidden and shown (switching activity filters, an agent changing status, or initial load with `filter: "awaiting"` from the sidebar badge where `forestByProject` starts empty and briefly flashes `"No agents match this filter."` at `:392`), React unmounts and remounts `AgentDashboardView`, resetting `expandedSubagents` and `panelWidth` and re-running its mount effects.
  Fix: Keep each project's `AgentDashboardView` mounted in a stable tree position (or compute forests in `TeamScreen` / suppress `"No agents match this filter."` until every section has reported its forest).

- **S20** · low · fixer · `shared/subagents.ts:42-47`, `:57-59` (`applySubagentUpdate`, `mergeSubagents`) · confirmed
  Failure: `applySubagentUpdate` handles `{ kind: "remove" }` by deleting the key from `live`. Because `mergeSubagents` merges `{ ...bootstrap, ...live }`, any sub-agent previously bootstrapped from timeline history (`client/AgentDashboard.tsx:1645-1664`) is immediately resurrected on the next render after a live `remove` event. Reproduced: `mergeSubagents(boot, applySubagentUpdate(live, { kind: "remove", ... }))` returned length `1`.
  Fix: Record a tombstone (e.g. `null` or a removed-key set) on `remove` and exclude tombstoned keys in `mergeSubagents`.

- **S21** · low · fixer · `server/team.ts:66-73` (`plannerProvider`) · confirmed
  Failure: Unlike `catalogFrom` (`shared/validate.ts:77`), `plannerProvider` does not filter out models with `isSelectable === false`. If a ready provider's `isDefault` or first model has `isSelectable: false`, `proposeTeam`, `proposeTeamEdit`, and `improveInstructions` start the planner on an unselectable model.
  Fix: Filter `models` with `model.isSelectable !== false` in `plannerProvider`.

- **S22** · low · fixer · `shared/permissions.ts:30-35` (`withAllowRule`) · confirmed
  Failure: If `.claude/settings.local.json` contains a non-object `permissions` value (such as a string or array), `withAllowRule` casts it to `Record<string, unknown>` and spreads `{ ...permissions, allow: [...] }`, writing corrupted index keys into `.claude/settings.local.json`. Reproduced: `withAllowRule({ permissions: "bad" }, PASEO_RUN_RULE)` returned `{"permissions":{"0":"b","1":"a","2":"d","allow":["Bash(paseo run *)"]}}`.
  Fix: Check `typeof settings.permissions === "object" && settings.permissions !== null && !Array.isArray(settings.permissions)` (and return an error from `allowPaseoRun` when malformed).

- **S23** · low · ui · `client/TeamPanel.tsx:973`, `shared/messages.ts:120` (`editSummary.changed` field labels) · confirmed
  Failure: The AI edit summary formats changed role fields via `t(\`role.${field}\`)`. For `field === "folders"`, `role.folders` is the input placeholder `"Folders (comma-separated, empty for no limit)"`, producing summary text like `"Changed role: ui (Folders (comma-separated, empty for no limit))"` in all four locales.
  Fix: Add a short field-name key (e.g. `role.foldersShort` or `review.fields.folders`) across `en`, `ko`, `ja`, and `zh` and use it in the edit summary.

#### Disagreements with R1-R22

- **R6** (`server/team.ts:443`): The suggested fix ("for a `{ projectId }` target ... refuse when `teamAtHome(teams, home)` already exists") breaks `restoreTeam` (`server/team.ts:422-428`, "Start in a new workspace" in `TeamScreen.tsx:302`), which loads an existing team file and calls `applyTeam({ projectId, team: saved.team }, ctx)` — where `teamAtHome(teams, home)` is always true. Fix `applyTeam` by using an internal helper for `restoreTeam` (or requiring callers updating an existing team to pass its `file`).
- **R2** (`shared/cleanup.ts:41`): Two parts of the suggested fix would cause regressions: (1) archiving `"plus finished planners"` across other workspaces breaks cross-navigation proposal recovery (`client/TeamPanel.tsx:520-527`, `followups.md:107`), which intentionally keeps finished `PROPOSAL_FOR` planners unarchived until the user returns to Apply or Cancel (`AgentRef` also lacks `status`); (2) matching `"or the project id"` unconditionally on a `{ workspaceId }` apply still kills an unrelated "New team" proposal (`PROPOSAL_FOR === projectId`) in `TeamScreen`. Scope cleanup to the applied `target` (plus the applied team's workspace ids) only.
- **R7** (`shared/cleanup.ts:64-75`): The second half of the suggested fix ("compare effort with the agent's value only when the team sets one") breaks reverting an orchestrator's effort from an explicit override (e.g. `"high"`) back to empty/default (`undefined`): `findOrchestrator` would match and reuse the `"high"` orchestrator instead of starting a new one on the model's `defaultEffort` (`"medium"`), regressing the behavior tested in `tests/effort.test.ts:169-187`. Only skip the effort check when both `team.orchestrator.effort === undefined` and `defaultEffort === undefined` (and `agent.thinkingOptionId == null`).
- **R8** (`server/team.ts:193` vs `:402`): The suggested fix ("in `readTeam` show a team only through `teamIn`") makes `TeamPanel.tsx:887-923` show the "This workspace has no team yet" creation card (Propose, Blank, Copy, Share) in a legacy role workspace where every action fails because `legacyWorkspaces` still reserves it (`applyTeam` clashes at `server/team.ts:443`; `shareWorkspace` refuses via `workspaceOwnerOf` at `:479`), wasting planner tokens and hiding which team owns the workspace. Keep surfacing the legacy reservation (e.g. return a `legacy` flag so `TeamPanel` disables Reset session and directs the user to re-apply the owning team, or block the Create card when reserved).
- **R12** (`shared/messages.ts:42`): The suggested fix ("add `roles_one` / `roles_other` in `en` (and `_other` in ko/ja/zh)") fails both `npm run typecheck` (`ko`/`ja`/`zh` are typed as `Shape<typeof en>` at `shared/messages.ts:147`) and `tests/messages.test.ts:31-33` (`expect(keys(resource)).toEqual(keys(en))`). Add both `roles_one` and `roles_other` to all four locales, matching `subagentCount`, `awaitingBadge`, and `sharedTeam`.

### Verification 2026-11-25

Checked working copy (`npm run typecheck` passes; 31 unit test files / 623 tests pass excluding `tests/daemon.e2e.test.ts`; all 19 RPCs in `shared/rpc.ts` match `index.server.ts`). Verdicts: 38 fixed, 6 partly fixed, 1 fixed in a way that breaks something else, 0 not fixed.

- **R1** · fixed · `server/team.ts:80`, `:185-191` (`projectTeams` catches per-file `readFile` errors into `errors`; `projectTeamsList` isolates per project via `.catch`).
- **R2** · fixed · `shared/cleanup.ts:11`, `:42-58`, `:100`; `server/team.ts:302`, `:324`, `:546-551` (edit/instructions planners tagged with `EDIT_FOR`; `plannerCleanup` scoped to applied target and the team's workspaces; Restore omits `proposalTarget(target)`).
- **R3** · fixed · `client/TeamPanel.tsx:570-580`, `:590-602` (`applied.onSuccess` clears `pendingKey` and calls `closeReview()` without server cancel while preserving the Applied result card).
- **R4** · fixed · `server/team.ts:276-282`, `:302`, `:308`, `:324`, `:330`, `:337-343`; `shared/rpc.ts:140-144`; `index.server.ts:14`; `client/TeamPanel.tsx:195-213`, `:245`, `:262`, `:444-445`, `:513`, `:527`, `:537` (`oneShotAnswer` archives edit/instructions planners on finished/failed; `team.planner.cancel` archives on Cancel, dialog close, and superseded starts; `EDIT_FOR` included in `team.delete`; unmount leak tracked separately in V3).
- **R5** · fixed · `client/panel-logic.ts:18-20`; `client/TeamPanel.tsx:79-99` (`effortChoices` appends any set effort missing from the model so `EffortPicker` stays shown and lets the user clear it to Default).
- **R6** · fixed · `server/team.ts:485-514` (`applyTeamTo` refuses replacing an existing `atHome` team unless `restore === true` or applied from that team's home/shared workspace).
- **R7** · fixed · `server/team.ts:420-431`, `:552`, `:576`; `shared/cleanup.ts:75-89` (`runOrchestrator` archives mismatched orchestrators before starting a replacement; `findOrchestrator` checks `!agent.thinkingOptionId` only when both team effort and `defaultEffort` are unset).
- **R8** · fixed · `server/team.ts:211`, `:219`; `client/panel-logic.ts:23-27`; `client/TeamPanel.tsx:670`, `:767-770`; `shared/messages.ts:98` (`readTeam` uses `teamIn` while keeping legacy role workspaces in `takenWorkspaces`, and `TeamPanel` shows `create.reservedByOtherTeam` instead of the Create card).
- **R9** · partly fixed · `client/panel-logic.ts:6-9`; `client/TeamPanel.tsx:230`, `:273`, `:484`, `:521`; missing at `client/TeamPanel.tsx:547`, `:648`, `:779` (polling stops on error in all three queries and `InstructionsDialog` clears `busy`, but `editBusy` at `:547` and `teamBusy` at `:648` still omit `!isError`, leaving the blocking "Please wait" progress modal open and spinning after polling stops; clearing `teamBusy` on error also requires rendering `planning.error` at `:779`).
- **R10** · fixed · `client/panel-logic.ts:12-15`; `client/TeamPanel.tsx:777` (`blankOrchestratorModel` picks ready Claude else first ready provider and its first model).
- **R11** · fixed · `client/TeamPanel.tsx:491-492` (`fresh` passes `[...projectWorkspaces, ...takenWorkspaces]` to `withFreeWorkspaces`).
- **R12** · fixed · `shared/messages.ts:59-61`, `:236-238`, `:411-413`, `:586-588` (`roles_one`/`roles_other` added in all four locales; confirmed via `PluginTranslationRuntime`: `"1 role"` / `"2 roles"`).
- **R13** · fixed · `client/agent-label.ts:8-32`; `client/AgentDashboard.tsx:140`, `:156`, `:175`, `:731-754`, `:1681-1690` (card `accessibilityLabel` includes title, kind/role, status, and model/effort/mode; `accessibilityState={{ busy: node.live }}`; `Badge` marked `aria-hidden`).
- **R14** · fixed · `client/ui/controls.tsx:19-31`; `client/AgentDashboard.tsx:773`, `:1156`, `:1444-1470`, `:1693` (`useDashboardData` reads `useReduceMotion()`, gates animation loops on `anyLive && !reduceMotion`, and suppresses packets/flash when still).
- **R15** · fixed · `client/AgentDashboard.tsx:322-340`, `:737`, `:742-744` (interactive cards show the tooltip immediately on keyboard focus via `onFocus`/`onBlur` and expose full text in `accessibilityLabel`).
- **R16** · fixed · `client/AgentDashboard.tsx:699-761`, `:1691`, `:1696` (hide `×` and Archive buttons are siblings of `cardBody` with `hitSlop={8}`, a 24×24 touch target for `×`, and agent-named labels).
- **R17** · fixed · `client/ui/controls.tsx:165-176`; `client/ui/Picker.tsx:78`; `client/TeamPanel.tsx:122`, `:138`, `:293`, `:319`, `:774`, `:815`, `:844` (all `TextInput`s have `accessibilityLabel`).
- **R18** · fixed · `client/TeamScreen.tsx:254`, `:298`, `:300`, `:304`; `client/TeamPanel.tsx:133`, `:162`, `:795`, `:796`; `shared/messages.ts` (all repeated row buttons have named `accessibilityLabel`s in all four locales).
- **R19** · fixed in a way that breaks something else · `client/ui/controls.tsx:58-151`; `client/ui/Picker.tsx:74-146`; `client/TeamScreen.tsx:364-387`; `client/AgentDashboard.tsx:1507-1514` (`Tabs`, `RadioGroup`, and combobox/listbox `PickerModal` with `aria-activedescendant` are implemented, but `useRoving` at `client/ui/controls.tsx:68` sets `tabIndex={-1}` on unselected items on all platforms while `onKeyDown` at `:9-11` is web-only, making unselected tabs and radio options unreachable by hardware keyboard on native iOS/Android — see V2).
- **R20** · fixed · `client/ui/controls.tsx:188-217`; `client/TeamPanel.tsx:466-467`, `:878-904`; `client/TeamScreen.tsx:323` (bottom errors and Applied result sit in pre-mounted `Errors`/`Notice` live regions and scroll into view; repeat-text edge case tracked in V4).
- **R21** · fixed · `client/AgentDashboard.tsx:106`, `:376`, `:682`, `:692` (card-level 0.45/0.85 opacity and 55% alpha `#ABCD` suffix removed; waiting cards dim only the logo while text stays at full contrast).
- **R22** · fixed · `client/TeamScreen.tsx:85` (`AwaitingBadge` root `View` is `accessible role="img" accessibilityLabel={label}` in `SidebarRow.trailing`).
- **S1** · fixed · `client/TeamPanel.tsx:170`, `:480-501`, `:572` (`draftedProposalId` ref prevents re-applying the same `plannerId` and `SETTLED_ONCE` disables focus/reconnect refetching).
- **S2** · fixed · `server/team.ts:353-366`, `:547-551` (`applyTeamTo` excludes `lead.id` and every team's reserved workspaces from planner workspace cleanup, and `archivePlanners` skips workspaces where archiving a planner agent failed).
- **S3** · partly fixed · `shared/agent-tree.ts:76-80`; missing at `shared/agent-tree.ts:245-259` (`canDismiss` now refuses parents with non-dismissible children, but `buildAgentForest` still unconditionally cascades `dismissed` to all descendants, so a previously dismissed parent still hides active/error/permission children when `showClosed: false` — reproduced: returned `{ trees: [], solo: [] }`).
- **S4** · fixed · `server/team.ts:517-519` (`applyTeamTo` always discards the draft's `sharedWorkspaces` and preserves the on-disk `atHome` list when updating an existing team).
- **S5** · fixed · `client/TeamPanel.tsx:612`, `:702`, `:888` (`unshared.data.failures` rendered in bottom `<Errors>` outside `{data.team && !draft}` / `confirmUnshare`, and `shared.onMutate` calls `unshared.reset()`; stale result/failure reset gaps tracked in V5).
- **S6** · fixed · `client/screen-logic.ts:10-15`; `client/TeamScreen.tsx:314`, `:316` (`reconnectChoices` excludes only other teams' homes and shared workspaces per team row, allowing promotion of the team's own shared workspace).
- **S7** · partly fixed · `client/TeamPanel.tsx:472-477`, `:563-589`, `:777`, `:795`; missing at `client/TeamPanel.tsx:611-618`, `:776-777`, `:796` (`pending` is gated on `!current.data.team` and `!draft`, and `startCounter` guards Blank/Copy against a late `propose`, but Share is neither disabled during `start.isPending` nor increments `startCounter` in `shared.onMutate`, Propose/Blank stay enabled during `shared.isPending`, and `pending`'s effect can still set `plannerId` while `start` or `shared` is in flight with `draft === null`).
- **S8** · fixed · `client/AgentDashboard.tsx:345-372`, `:763-767`, `:841-845` (`subagentPill` is no longer suppressed when `collapsed` is true).
- **S9** · fixed · `client/TeamScreen.tsx:23-44` (`useProjectTeams` subscribes to `paseo.workspaces.subscribe`, coalesced to 1 s, to invalidate `PROJECT_TEAMS_KEY`).
- **S10** · fixed · `client/TeamScreen.tsx:146-153` (`params` effect calls `setProjectId(null)` when `params?.tab === "agents"`, leaving `<TeamEditor />`).
- **S11** · partly fixed · `server/team.ts:438-456`, `:544`; defect at `client/TeamPanel.tsx:900`, `client/TeamScreen.tsx:218`, `shared/messages.ts:173`, `server/team.ts:576` (`notifyOrchestrators` avoids silent drift by keeping other workspaces' orchestrators and reporting outdated ones with a "use Reset session" message, but appends that notice to `cleanup` which clients render under `"Could not clean up the planner: {{failure}}"` — confirming open point (a), see V1 — and `shareWorkspace` at `:576` omits `reportOutdated = false`).
- **S12** · partly fixed · `server/team.ts:84`, `:149`, `:164-166`, `:530`; missing at `server/team.ts:564`, `:566`, `:574`, `:597`, `:601` (`projectTeamsList`, `teamRoster`, and `applyTeamTo`/`restoreTeam` deduplicate via `oneFilePerTeam` and rewrite all `sameTeamFiles`, but `shareWorkspace` and `unshareWorkspace` still validate, build prompts, and notify from `own[0]` instead of the requested `file` — reproduced with diverged `.agents/team.json` and `.agents/teams/lead.json`).
- **S13** · fixed · `shared/team.ts:46-52` (`TeamSchema.superRefine` rejects case-insensitive duplicate `sharedWorkspaces` and the home workspace listed as shared, which also prevents `unshareWorkspace` at `server/team.ts:589` from matching the home workspace).
- **S14** · fixed · `client/TeamPanel.tsx:422`; `client/TeamScreen.tsx:239` (`TeamEditor` is keyed by `workspaceId` and `projectId`).
- **S15** · fixed · `shared/proposal.ts:58-101` (`jsonIn` tries fenced blocks, then first-`{`..last-`}`, then balanced `{ ... }` objects skipping JSON strings).
- **S16** · fixed · `client/screen-logic.ts:18-20`; `client/TeamScreen.tsx:180` (`closedIds` is computed via `closedIdsOf` over active `agentSections` only).
- **S17** · fixed · `client/TeamScreen.tsx:158` (`agentSections` checks `dashState.showClosed || !isHidden(agent)`).
- **S18** · fixed · `client/panel-logic.ts:30-33`; `client/TeamPanel.tsx:668-669`, `:893-903` (`latestResult(applied, shared)` surfaces `shared.data.cleanup`, `permission`, and `Open orchestrator` in the result card).
- **S19** · partly fixed · `client/TeamScreen.tsx:396`; missing at `client/TeamScreen.tsx:162-168`, `:402-408` (initial `"No agents match this filter."` flash is suppressed until all sections report a forest, but `shownSections` and `hiddenSections` still sit in separate subtrees so `AgentDashboardView` unmounts/remounts across shown↔hidden transitions, resetting `expandedSubagents` and `panelWidth` — confirming open point (b)).
- **S20** · fixed · `shared/subagents.ts:13`, `:44-54`, `:59-61`; `tests/review-fixes-2.test.ts:227-245`, `:275-281` (non-running `removed: true` tombstone suppresses timeline resurrection; on open point (c): tombstoning a `remove` for an unknown `live` key is intentional and needed to hide timeline-bootstrapped sub-agents, and a later `upsert` restoring a removed sub-agent IS tested at `tests/review-fixes-2.test.ts:240-244`; however a `timeline` event after such a tombstone has a bug — see V8).
- **S21** · fixed · `server/team.ts:71` (`plannerProvider` filters out models with `isSelectable === false`).
- **S22** · fixed · `shared/permissions.ts:30-36`; `server/team.ts:385-386` (`allowPaseoRun` checks `permissionsProblem` before `withAllowRule` and refuses non-object `permissions` or non-array `permissions.allow` without modifying `.claude/settings.local.json`; direct `withAllowRule` callers still rely on checking `permissionsProblem` first).
- **S23** · fixed · `shared/messages.ts:146`, `:323`, `:498`, `:673`; `client/TeamPanel.tsx:856` (`role.foldersName` added in all four locales and used for `field === "folders"` in the edit summary).

#### New defects

- **V1** · medium · fixer + ui · `server/team.ts:451`, `:552`, `:576`; `shared/messages.ts:173`, `:350`, `:525`, `:700`; `client/TeamPanel.tsx:900`; `client/TeamScreen.tsx:218` · confirmed
  Failure: `applyTeamTo` (`:552`) and `shareWorkspace` (`:576`) place R7 orchestrator-archive failures and S11 outdated-orchestrator advisories (`"orchestrator … still runs on …; use Reset session in …"`) into `cleanup`, and `shareWorkspace` (`:576`) omits `reportOutdated = false` (unlike `unshareWorkspace` at `:601`). Both `TeamPanel.tsx:900` and `TeamScreen.tsx:218` display every `cleanup` entry with `t("result.cleanupFailed", { failure })` (`"Could not clean up the planner: {{failure}}"` across all four locales), misreporting outdated-orchestrator notices and orchestrator archive errors as planner cleanup failures.
  Fix: Separate non-planner notices from `cleanup` in `teamApplyRpc.output` (or reword `result.cleanupFailed` across all four locales to a general post-apply warning/issue heading) and pass `reportOutdated = false` in `shareWorkspace` (`server/team.ts:576`).

- **V2** · medium · ui · `client/ui/controls.tsx:8-11`, `:68` · confirmed
  Failure: `useRoving` (used by `Tabs` in `TeamScreen` and `RadioGroup` for activity filters and `DensityToggle`) sets `tabIndex: (index === stop ? 0 : -1)` on all platforms, while `onKeyDown` (`:9-11`) is disabled whenever `Platform.OS !== "web"`. In React Native 0.81 (`ViewPropTypes.d.ts:117-125`), `tabIndex={-1}` removes a view from hardware-keyboard focus order, so on native iOS/Android with a hardware keyboard every unselected tab and radio option is completely unreachable (neither Tab nor arrow keys can reach it), regressing keyboard accessibility relative to the original `Pressable`s.
  Fix: Gate `tabIndex` to `Platform.OS === "web"` (`...(Platform.OS === "web" ? { tabIndex: (index === stop ? 0 : -1) as 0 | -1 } : {})`), matching `client/ui/Picker.tsx:132`.

- **V3** · medium · ui · `client/TeamPanel.tsx:215-224`, `:504-546` · confirmed
  Failure: Neither `TeamEditor` nor `InstructionsDialog` cancels an in-flight one-shot planner (`editPlannerId`/`startTeamEdit` or `InstructionsDialog`'s `plannerId`/`startImprove`) on unmount. With S14 keying `TeamEditor` by `workspaceId` (`:422`) and S10 clearing `projectId` on a sidebar badge click (`TeamScreen.tsx:150`), switching workspaces, clicking "Back to projects", or clicking the sidebar badge during "Edit team with AI" or "Improve with AI" unmounts the component without calling `cancelPlanner` or bumping the request counter. Because `pendingProposal` never recovers `EDIT_FOR` planners, nothing polls `oneShotAnswer` to archive them, leaving the planner running and unarchived indefinitely.
  Fix: Store the active one-shot planner id in a ref in both `TeamEditor` and `InstructionsDialog` and add an unmount cleanup effect that increments the request counter and calls `stopPlanner(idRef.current)` when set.

- **V4** · low · ui · `client/ui/controls.tsx:188-197`; `client/TeamPanel.tsx:878-904` · confirmed
  Failure: `Notice` skips `onShown` and iOS `AccessibilityInfo.announceForAccessibility` whenever `announce === shown.current` (`controls.tsx:192`). On `TeamPanel.tsx:891`, `announce` is `t("result.applied", { file: result.file })` (omitting `result.cleanup` and `result.permission`), and `applied.data` is kept while a second apply runs. Pressing "Apply again" twice or editing and re-applying the same team file keeps `announce` unchanged, so `showMessages()` (`scrollToEnd`) does not run and iOS does not re-announce the updated result card (the same happens on `<Errors onShown={showMessages}>` at `:878` when two consecutive actions fail with the same error text).
  Fix: Pass a submission token (e.g. `applied.submittedAt` / `shared.submittedAt` / `restarted.submittedAt`) to `Notice` and `Errors` so repeat outcomes re-trigger `onShown` and iOS announcements, and include `result.cleanup` warnings in `announce`.

- **V5** · low · ui · `client/TeamPanel.tsx:590-626`, `:668-669`, `:888` · confirmed
  Failure: `unshared.onSuccess` (`:621-625`) never resets `shared` or `applied`, so after sharing (or applying) and then unsharing a workspace, the panel switches back to the Create card while `latestResult(applied, shared)` (`:668`) keeps showing the stale `"Applied: …"` card with an `"Open orchestrator"` button pointing to the orchestrator that unshare just archived. Conversely, `applied` (`:590`) never resets `unshared`, so stale `unshared.data.failures` (`:888`) stay visible after creating a new team with Apply.
  Fix: Call `shared.reset()` and `applied.reset()` in `unshared.onSuccess`, and call `unshared.reset()` in `applied.onMutate` (matching `shared.onMutate` at `:612`).

- **V6** · low · ui · `client/ui/Picker.tsx:21-40`, `:41-47`, `:65-69`, `:106-108` · confirmed
  Failure: `PickerModal` does not clear `query` when closing (`pick` or `onOpenChange`), resetting it only in `useEffect([request])` (`:33`) after the first render of the next open. Filtering one picker (e.g. typing `"codex"` in Provider), selecting an option, and opening another picker (e.g. Model) renders the first frame with stale `query = "codex"` against the new options, flashing `"No matching options"` and triggering a spurious `<Notice tone="status">` announcement before `useEffect` clears `query`.
  Fix: Reset `query`, `rowLayouts`, and `scrollY` synchronously on close in `pick` and `onOpenChange` (or derive/reset state when `request` changes before rendering the list).

- **V7** · low · ui · `client/TeamPanel.tsx:302-317`, `:851-863`; `client/TeamScreen.tsx:311-335` · confirmed
  Failure: `Notice` documents "Keep it mounted and change its children" (`client/ui/controls.tsx:184`) because web `role="status"` live regions are reliably announced only when already mounted before content appears. Four callers conditionally mount `<Notice tone="status">` already populated (`TeamPanel.tsx:303`, `:852`; `TeamScreen.tsx:312`, `:327`), and `TeamScreen.tsx:311-335` wraps interactive confirmation controls (buttons plus a nested `<Errors role="alert">` at `:323`) inside `role="status"`, causing web screen readers to miss initial announcements or re-read button labels when `reconnectBusy` toggles inside the panel.
  Fix: Keep `Notice` mounted around status-only text (e.g. `suggestion` and `editSummary`), and render the interactive reconnect/delete confirmation panels as `<View>` / `<Group>` with a separate pre-mounted status/error live region for announcements.

- **V8** · low · fixer · `shared/subagents.ts:47`, `:51-54` · confirmed
  Failure: A `{ kind: "remove" }` event for a key absent from `live` stores a synthetic tombstone with `createdAt: ""` (`:47`). If a `timeline` event later arrives for that key (e.g. out-of-order after `remove` or reusing the id), `:52-53` reuses the tombstone instead of the `??` default, strips `removed`, resurrects the sub-agent as `status: "running"` (keeping dashboard animations active in `AgentDashboard.tsx:1445`), and leaves `createdAt: ""` instead of `value.timestamp` (reproduced via `applySubagentUpdate` + `mergeSubagents`).
  Fix: Ignore `timeline` events for tombstoned keys (`if (current[key]?.removed) return current;`, letting only `upsert` restore them), or fall back to `createdAt: previous.createdAt || value.timestamp` when clearing a tombstone.

<!-- followup: fu-47de9e53039d | source: paseo-project-team-plugin | task: 1 | date: 2026-10-29 | status: open | taken: - -->
- `paseo.workspaces.list()`·`agents.list()`의 페이지네이션을 따라가지 않음. workspace가 많은 호스트에서는 이름 매칭이 누락돼 중복 생성될 수 있음. 팀 삭제(`deleteTeam`)도 같은 한계를 가짐: 다음 페이지의 팀 에이전트는 보관되지 않음

<!-- followup: fu-e0953b53000b | source: paseo-project-team-plugin | task: 1 | date: 2026-10-29 | status: open | taken: - -->
- 계획 에이전트를 읽기 전용 모드(claude Plan Mode 등)로 띄우기. 현재는 프롬프트로만 파일 변경을 막음

<!-- followup: fu-4a2dd60fb648 | source: paseo-project-team-plugin | task: 1 | date: 2026-10-29 | status: open | taken: - -->
- Paseo 기본 UI로 workspace에서 에이전트를 띄울 때 역할 모델을 자동 적용(생성 시점 훅 확인 필요)

<!-- followup: fu-bdf2f2bad552 | source: sidebar-team-create | task: 2 | date: 2026-10-29 | status: taken | taken: 3 -->
- Apply 성공 시 계획 에이전트 정리: 플러그인이 만든 "Team planner" workspace는 `paseo.workspaces.archive()`로 보관하고, 기존 workspace에서 띄운 계획 에이전트는 에이전트만 보관한다. 검토 중에는 화면을 떠났다 돌아와도 제안을 이어받아야 하므로(계획 에이전트 유지) 제안 완료가 아니라 Apply 성공 시점에 정리한다.
  근거: UAT 중 사용자가 agents-test 프로젝트에 남은 "Team planner" workspace를 닫을 수 있는지 문의. 이번 계획은 이 정리를 비목표로 두었다.

<!-- followup: fu-0520c8ed98cc | source: max-permission-mode | task: 4 | date: 2026-10-30 | status: open | taken: - -->
- 배포 스킬(`.claude/skills/deploy/SKILL.md`) 5단계를 실제 환경에 맞게 고친다. `getpaseo/plugins`에는 lockfile이 없어 `npm ci`가 실패하고, `node scripts/validate.ts`는 auto mode 분류기가 막는다. 의존성 설치 방식을 바꾸거나, 사용자가 직접 실행하는 단계로 명시하거나, 권한 규칙을 추가해야 한다.
  근거: v0.1.3 배포 때 release 에이전트와 오케스트레이터가 모두 거부당했고, 사용자가 직접 실행했을 때 `npm ci`가 EUSAGE로 실패했다.

<!-- followup: fu-1145da606e5c | source: max-permission-mode | task: 4 | date: 2026-10-30 | status: taken | taken: 7 -->
- `tests/daemon.e2e.test.ts`가 끝날 때 자기가 만든 오케스트레이터와 그 오케스트레이터가 띄운 역할 에이전트를 보관(archive)하게 한다. 지금은 임시 `pwa-game-*` workspace에 idle 에이전트가 쌓인다.
  근거: 이번 e2e 3회로 오케스트레이터 3개와 smoke test 역할 에이전트 5개가 남았다.

<!-- followup: fu-3c0b7a9e21d4 | source: agent-dashboard-tab | task: 5 | date: 2026-10-30 | status: taken | taken: 6 -->
- 대시보드 effort 칩: effort 값(`thinkingOptionId`/`effectiveThinkingOptionId`)이 비어 있으면 provider snapshot의 모델 `defaultThinkingOptionId`를 흐리게 표시한다. Paseo 화면이 하는 방식과 같다.
  근거: 오케스트레이터 입력창은 effort가 비어 있는데도 "Medium"을 표시했고, snapshot의 claude-opus-5-5 기본값도 medium이다. 대시보드의 claude 카드에는 effort 칩이 없다.

<!-- followup: fu-9d41c6a2e7b0 | source: per-workspace-orchestrator | task: 9 | date: 2026-10-30 | status: open | taken: - -->
- e2e가 만든 임시 `pwa-game-*` 프로젝트의 워크스페이스는 보관되지 않아 사이드바에 쌓인다(에이전트는 보관됨). e2e의 `afterAll`에서 임시 워크스페이스도 보관한다.
  근거: UAT 중 사이드바에 `pwa-game-*` 프로젝트가 4개 이상 보였다.

<!-- followup: fu-f442abd3e622 | source: keep-orchestrator-after-clear | task: 12 | date: 2026-10-30 | status: open | taken: - -->
같은 에이전트를 그 자리에서 비우는 세션 리셋을 검토한다. 테스트 에이전트에 플러그인 send("/clear")를 보내 Paseo가 보관 후 새로 만드는지, 같은 에이전트 안에서 비우는지 측정하고, 라벨·시스템 프롬프트를 유지하는 /clear를 Paseo에 기능 요청할지 판단한다.

<!-- followup: fu-14efcc321792 | source: agent-dashboard-explorer | task: 13 | date: 2026-10-30 | status: open | taken: - -->
- 아주 좁은 폭(오른쪽 사이드바)에서는 오케스트레이터 카드를 줄여도 역할 카드가 넘친다. 역할 카드 축소나 세로 쌓기를 검토할 것.
  Evidence: app.paseo.sh 사이드바에서 축소 카드 옆 역할 카드가 오른쪽으로 잘려 하단 스크롤이 필요했다.

<!-- followup: fu-64d8c26f699a | source: keep-team-proposal-across-navigation | task: 14 | date: 2026-10-30 | status: open | taken: - -->
- e2e "applies the team: file, workspaces and orchestrator"가 `tests/daemon.e2e.test.ts:163`에서 실패한다. `projectTeamsList`는 팀 파일 경로를 상대 경로로, Apply는 절대 경로로 돌려준다. 어느 쪽이 맞는지 정해 한쪽을 맞출 것.
  Evidence: 2026-10-30 e2e 실행에서 기대값은 `/var/folders/.../pwa-game-KWDUAb/.agents/teams/orchestrator.json`, 실제값은 `.agents/teams/orchestrator.json`이었다.

<!-- followup: fu-83ae26233411 | source: team-editor-select-layout | task: 14 | date: 2026-11-02 | status: taken | taken: 16 -->
- 팀이 이미 있는 워크스페이스의 팀 패널에 "This workspace has no team yet…" 생성 카드가 팀 요약 아래에 함께 보인다. 문구가 사실과 다르고, 같은 워크스페이스에 두 번째 팀을 만들라는 것처럼 읽힌다.
  Evidence: app.paseo.sh orchestrator-2 팀 패널에서 확인. `client/TeamPanel.tsx`의 생성 카드 조건이 `!draft`뿐이고, 5fa77ca에도 같은 조건이었다.

<!-- followup: fu-b09bdbecf2ea | source: team-edit-with-ai | task: 15 | date: 2026-11-06 | status: open | taken: - -->
- 앱에서 "AI로 팀 편집"을 실제로 돌려 요약 카드·적용/버리기·Cancel 동작과 planner 응답 품질(요청하지 않은 role을 건드리지 않는지)을 확인한다.
  Evidence: 종료 조건 C1~C8은 계약·로직·문구·로드만 검사하며 화면과 실제 planner 출력은 확인하지 않았다.

<!-- followup: fu-b22ddb3a5c98 | source: team-edit-with-ai | task: 15 | date: 2026-11-06 | status: open | taken: - -->
- tests/daemon.e2e.test.ts에서 지운 "proposes one role from a description" 케이스 대신 team.edit.propose/proposal을 실제 데몬으로 돌리는 E2E 케이스를 추가한다.
  Evidence: S2에서 role planner E2E 케이스를 제거했고 대체 E2E는 없다(PASEO_E2E는 토큰 비용 때문에 이번 범위에서 제외).

<!-- followup: fu-ed054f0ae86b | source: agent-teams-screen-visual-hierarchy | task: 17 | date: 2026-11-08 | status: open | taken: - -->
- 공용 Button에 작은 크기(compact) 옵션을 추가해 Agent teams 팀 행의 팀 열기·재연결·삭제 버튼도 한 단계 줄인다. 시안 A가 요청한 "버튼도 작게"가 빠져 있다.
  Evidence: ui#2B7D 보고 — 공용 Button에 compact 옵션이 없어 버튼 크기를 그대로 두었다(run.md S1 ⚠).

<!-- followup: fu-5355074dacb2 | source: all-agents-dashboard-tab | task: 19 | date: 2026-11-09 | status: open | taken: - -->
- 전체 에이전트 탭은 모든 프로젝트의 미보관 에이전트마다 하위 에이전트 탐지용 타임라인(최근 200개)을 읽는다. 에이전트가 많은 호스트에서 데몬 부하(지난 RPC 폭주와 같은 계열)를 측정하고, 필요하면 열린 섹션만 읽거나 상한을 둔다.
  Evidence: S3 구현은 기존 대시보드의 subagents 쿼리를 프로젝트 섹션마다 쓴다. README Limitations에 이미 "에이전트 수만큼 요청"이 적혀 있다.

<!-- followup: fu-df3401582691 | source: all-agents-dashboard-tab | task: 19 | date: 2026-11-09 | status: open | taken: - -->
- 전체 에이전트 탭의 밀도·닫힌 에이전트 표시·숨긴 목록이 화면을 떠나면 초기화된다. 호스트 단위 플러그인 설정(registerSettings)이나 다른 저장소로 유지할지 검토한다.
  Evidence: S3는 TeamScreen의 React state로 보관(화면에는 패널 탭 상태가 없음).

<!-- followup: fu-362feeaab3c2 | source: copy-share-team-2of2 | task: 22 | date: 2026-11-12 | status: open | taken: - -->
- 공유 성공 경로(teamShareRpc가 워크스페이스에 오케스트레이터를 시작하고 다른 워크스페이스에 알림)의 서버 핸들러 테스트를 추가한다.
  Evidence: S3 tester는 providers.listFeatures·agents.create·권한 파일까지 fake가 커져 거부 경로만 테스트했다(run.md S3).

<!-- followup: fu-01dcbbeea0b3 | source: copy-share-team-2of2 | task: 22 | date: 2026-11-12 | status: open | taken: - -->
- README·OVERVIEW에 Agent teams 화면 팀 행의 "공유: …" 표시를 설명한다.
  Evidence: release가 문서에 넣지 않았다고 보고했다(run.md S5 ⚠). 표시는 client/TeamScreen.tsx:282에 구현돼 있다.
