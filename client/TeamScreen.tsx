import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Easing, Platform, ScrollView, Text, View } from "react-native";
import { withAlpha } from "../shared/color";
import { activityCounts, awaitingResponseCount, filterForest, forestActivityCounts, isHidden, type ActivityFilter, type AgentForest, type AgentNode } from "../shared/agent-tree";
import { messages } from "./i18n";
import { teamDeleteRpc, teamProjectsRpc, teamReconnectRpc, teamRestoreRpc } from "../shared/rpc";
import { AgentDashboardView, ClosedControls, DEFAULT_STATE, DensityToggle, useAgentsRefresh, useDashboardAgents, useDashboardData, type DashboardState } from "./AgentDashboard";
import { PROJECT_TEAMS_KEY, TeamEditor } from "./TeamPanel";
import { Button, Errors, Group, LinkButton, Notice, Prompt, RadioGroup, TabPanel, Tabs, useReduceMotion } from "./ui/controls";
import { noticesOf } from "./panel-logic";
import { closedIdsOf, reconnectChoices } from "./screen-logic";
import { styles } from "./ui/styles";

export const SCREEN_ID = "team";

const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "working", "awaiting", "idle"];

/** Every project and its teams, refetched when the host's projects or workspaces change. */
function useProjectTeams() {
  const list = useRpc(teamProjectsRpc);
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  // Workspace events come in bursts (create, rename, archive), so they refetch at most once a second.
  useEffect(() => {
    const refetch = () => void queryClient.invalidateQueries({ queryKey: PROJECT_TEAMS_KEY });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refetchSoon = () => {
      timer ??= setTimeout(() => {
        timer = null;
        refetch();
      }, 1000);
    };
    const off = [paseo.projects.subscribe(refetch), paseo.workspaces.subscribe(refetchSoon)];
    return () => {
      if (timer !== null) clearTimeout(timer);
      off.forEach((stop) => stop());
    };
  }, [paseo, queryClient]);
  return useQuery({ queryKey: PROJECT_TEAMS_KEY, queryFn: () => list({}) });
}

type SidebarColors = PluginSidebarItemProps["theme"]["colors"];

/** The awaiting-answer count pill, mounted only while the count is above 0: a pulse ring while it shows, one bump on mount and whenever the count grows; both off under reduced motion. */
function AwaitingBadge({ count, colors, label }: { count: number; colors: SidebarColors; label: string }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const bump = useRef(new Animated.Value(1)).current;
  const previous = useRef(0);
  const reduceMotion = useReduceMotion();
  const native = Platform.OS !== "web";
  const pulsing = count > 0 && !reduceMotion;
  useEffect(() => {
    if (!pulsing) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.ease), useNativeDriver: native }),
        Animated.delay(400),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
      pulse.setValue(0);
    };
  }, [pulsing, pulse, native]);
  useEffect(() => {
    const grew = count > previous.current;
    previous.current = count;
    if (!grew || reduceMotion) return;
    const animation = Animated.sequence([
      Animated.timing(bump, { toValue: 1.25, duration: 120, useNativeDriver: native }),
      Animated.timing(bump, { toValue: 1, duration: 130, useNativeDriver: native }),
    ]);
    animation.start();
    return () => {
      animation.stop();
      bump.setValue(1);
    };
  }, [count, reduceMotion, bump, native]);
  return (
    <View accessible role="img" accessibilityLabel={label}>
      {pulsing ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            borderRadius: 10,
            backgroundColor: colors.statusWarning,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }],
          }}
        />
      ) : null}
      <Animated.View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.statusWarning, transform: [{ scale: bump }] }}>
        <Text style={{ color: colors.surface0, fontSize: 12, fontWeight: "700" }}>{count > 99 ? "99+" : String(count)}</Text>
      </Animated.View>
    </View>
  );
}

/** The sidebar row; a badge counts agents waiting for the user's answer and opens the All agents tab. */
export function TeamSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const { t } = useTranslation(messages);
  useAgentsRefresh();
  const agents = useDashboardAgents(false);
  const count = awaitingResponseCount((agents.data?.entries ?? []).map((entry) => entry.agent));
  return (
    <SidebarRow
      icon="Users"
      label={t("commandTitle")}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen(count > 0 ? { screenId: SCREEN_ID, params: { tab: "agents", filter: "awaiting", at: String(Date.now()) } } : { screenId: SCREEN_ID })}
      trailing={count > 0 ? <AwaitingBadge count={count} colors={theme.colors} label={t("screen.awaitingBadge", { count })} /> : undefined}
    />
  );
}

/** Browse every project's agent teams, open an existing team's panel, or create a new team. */
export function TeamScreen({ theme, layout, navigation, params, openTeamPanel }: PluginScreenProps & { openTeamPanel?: (workspaceId: string) => void }) {
  const s = useMemo(() => styles(theme.colors, layout.compact), [theme, layout.compact]);
  const { t } = useTranslation(messages);
  const tabsId = useId();
  const projects = useProjectTeams();
  const [listWidth, setListWidth] = useState(0);
  const columns = layout.compact || listWidth < 720 ? 1 : listWidth < 1120 ? 2 : 3;
  const toast = useToast();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<"teams" | "agents">(params?.tab === "agents" ? "agents" : "teams");
  const paramFilter = ACTIVITY_FILTERS.find((filter) => filter === params?.filter);
  const [dashState, setDashState] = useState<DashboardState>(DEFAULT_STATE);
  const dashboard = useDashboardData(dashState.showClosed);
  const [closedByProject, setClosedByProject] = useState<Record<string, string[]>>({});
  const allAgents = useMemo(() => (dashboard.agents.data?.entries ?? []).map((entry) => entry.agent), [dashboard.agents.data]);
  const agentCounts = activityCounts(allAgents);
  const agentTotal = agentCounts.working + agentCounts.awaiting + agentCounts.idle;
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(paramFilter ?? "all");
  // The sidebar badge opens this screen on the All agents tab with a filter, also when it is already open; `at` makes each press a new param set.
  useEffect(() => {
    if (params?.tab === "agents") {
      setTab("agents");
      // Also leaves the New team view, which would otherwise keep covering the tab.
      setProjectId(null);
    }
    if (paramFilter) setActivityFilter(paramFilter);
  }, [params?.tab, params?.at, paramFilter]);
  const [forestByProject, setForestByProject] = useState<Record<string, AgentForest>>({});
  // A section's view remounts when it changes column or leaves the filter, so what it would lose is kept here (agent ids are unique across projects).
  const [expandedSubagents, setExpandedSubagents] = useState<Record<string, boolean>>({});
  const [widthByProject, setWidthByProject] = useState<Record<string, number>>({});
  const agentSections = useMemo(() => (projects.data ?? []).flatMap((project) => {
    const ids = project.workspaces.map((workspace) => workspace.id);
    const scope = new Set(ids);
    return allAgents.some((agent) => scope.has(agent.workspaceId ?? "") && (dashState.showClosed || !isHidden(agent))) ? [{ project, ids }] : [];
  }), [projects.data, allAgents, dashState.showClosed]);
  const counts = forestActivityCounts(agentSections.flatMap(({ project }) => forestByProject[project.id] ?? []));
  // A section is shown unless its forest is known and has no tree matching the filter; hidden ones stay mounted so they keep reporting.
  const shownSections = agentSections.filter(({ project }) => {
    const forest = forestByProject[project.id];
    if (!forest) return activityFilter === "all";
    const filtered = filterForest(forest, activityFilter);
    return filtered.trees.length + filtered.solo.length > 0 || activityFilter === "all";
  });
  const hiddenSections = agentSections.filter((section) => !shownSections.includes(section));
  // Shown sections fill the columns, each into the lightest one; a section's weight comes from its reported (filtered) forest.
  const countNodes = (node: AgentNode): number => 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
  const sectionColumns: (typeof shownSections)[] = Array.from({ length: columns }, () => []);
  const sectionWeights = sectionColumns.map(() => 0);
  for (const section of shownSections) {
    const forest = forestByProject[section.project.id];
    const filtered = forest ? filterForest(forest, activityFilter) : undefined;
    const lightest = sectionWeights.indexOf(Math.min(...sectionWeights));
    sectionColumns[lightest]!.push(section);
    sectionWeights[lightest]! += 3 + (filtered ? [...filtered.trees, ...filtered.solo].reduce((sum, node) => sum + countNodes(node), 0) : 0);
  }
  const closedIds = useMemo(() => closedIdsOf(agentSections.map(({ project }) => project.id), closedByProject), [agentSections, closedByProject]);
  const queryClient = useQueryClient();
  const remove = useRpc(teamDeleteRpc);
  const reconnect = useRpc(teamReconnectRpc);
  const restore = useRpc(teamRestoreRpc);
  // The team row waiting for a second press, keyed by project and file.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const invalidateTeams = () => {
    void queryClient.invalidateQueries({ queryKey: PROJECT_TEAMS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["workspace-agents", "team"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "agents"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "roster"] });
  };
  const deleted = useMutation({
    mutationFn: (team: { projectId: string; file: string }) => remove(team),
    onSuccess: (result) => {
      if (result.failures.length) toast.error(t("screen.deleteFailed", { failure: result.failures.join("; ") }));
      if (result.fileFailures.length) toast.error(t("screen.deleteFileFailed", { failure: result.fileFailures.join("; ") }));
      setConfirming(null);
      invalidateTeams();
    },
    onError: (error) => toast.error(String(error)),
  });
  const reconnected = useMutation({
    mutationFn: (input: { projectId: string; file: string; workspaceId: string }) => reconnect(input),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.errors.join("; "));
        return;
      }
      setReconnecting(null);
      invalidateTeams();
    },
    onError: (error) => toast.error(String(error)),
  });

  const openApplied = (result: Extract<RpcOutput<typeof teamRestoreRpc>, { ok: true }>) => {
    if (result.cleanup.length) toast.error(t("result.cleanupFailed", { failure: result.cleanup.join("; ") }));
    // Opening the workspace leaves this screen, so the advice is also shown where it stays visible.
    if (navigation) noticesOf(result).forEach((line) => toast.show(line));
    navigation?.openWorkspace({ workspaceId: result.workspaces[0]!.id });
  };
  // Advice from the last restore that is not a failure, such as an orchestrator elsewhere still running on the old team.
  const [advice, setAdvice] = useState<string[]>([]);
  const restored = useMutation({
    onMutate: () => setAdvice([]),
    mutationFn: (input: { projectId: string; file: string }) => restore(input),
    onSuccess: (result) => {
      if (!result.ok) return;
      setReconnecting(null);
      invalidateTeams();
      setAdvice(noticesOf(result));
      openApplied(result);
    },
  });
  const reconnectBusy = reconnected.isPending || restored.isPending;

  if (projectId) {
    return (
      <View style={s.screen}>
        <View style={[s.row, { padding: layout.compact ? 12 : 20, paddingBottom: 0 }]}>
          <Button s={s} secondary label={t("screen.back")} onPress={() => setProjectId(null)} />
        </View>
        <TeamEditor
          key={projectId}
          theme={theme}
          layout={layout}
          navigation={navigation}
          target={{ projectId }}
          onApplied={openApplied}
        />
      </View>
    );
  }

  type ProjectEntry = NonNullable<typeof projects.data>[number];
  const newTeamLink = (project: { id: string; name: string }) => (
    <LinkButton
      label={t("screen.newTeam")}
      accessibilityLabel={t("screen.newTeamNamed", { project: project.name })}
      color={theme.colors.accent}
      bold
      icon={<Icon name="Plus" size={14} color={theme.colors.accent} />}
      onPress={() => setProjectId(project.id)}
    />
  );
  const projectTitleBar = (project: { name: string; root: string }, action?: ReactNode) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: withAlpha(theme.colors.accent, 0.1), borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text accessibilityRole="header" style={[s.text, { fontSize: 15, fontWeight: "700" }]}>{project.name}</Text>
        <Text style={[s.muted, { flex: 1, minWidth: 0, fontSize: 11 }]} numberOfLines={1}>{project.root}</Text>
      </View>
      {action}
    </View>
  );
  const insetPanel = { width: "100%" as const, backgroundColor: theme.colors.surface2, borderRadius: 6, padding: 10, gap: 6 };
  // Projects without a team or error leave the grid; the rest fill the columns, each into the lightest one.
  const emptyProjects = (projects.data ?? []).filter((project) => !project.teams.length && !project.errors.length);
  const teamColumns: ProjectEntry[][] = Array.from({ length: columns }, () => []);
  const columnWeights = teamColumns.map(() => 0);
  for (const project of projects.data ?? []) {
    if (!project.teams.length && !project.errors.length) continue;
    const lightest = columnWeights.indexOf(Math.min(...columnWeights));
    teamColumns[lightest]!.push(project);
    columnWeights[lightest]! += 2 + project.teams.length;
  }
  const renderProject = (project: ProjectEntry) => {
    return (
      <View key={project.id} style={[s.card, { minWidth: 0, padding: 0, gap: 0, overflow: "hidden" }]}>
        {projectTitleBar(project, newTeamLink(project))}
        <Errors s={s} errors={project.errors} style={{ paddingHorizontal: 12, paddingTop: 10 }} />
        {project.teams.map((team, index) => (
          <Group key={team.file} label={team.orchestratorWorkspace} style={{ minWidth: 0, paddingHorizontal: 12, paddingVertical: 10, gap: 6, borderTopWidth: index > 0 ? 1 : 0, borderTopColor: theme.colors.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View aria-hidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: team.workspaceId ? theme.colors.accent : theme.colors.statusWarning }} />
              <Text style={[s.text, { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "700" }]}>{team.orchestratorWorkspace}</Text>
              <Text style={s.muted}>{t("screen.roles", { count: team.roles })}</Text>
            </View>
            {team.goal ? <Text style={s.muted} numberOfLines={2}>{team.goal}</Text> : null}
            {team.sharedWorkspaces.length ? <Text style={s.muted}>{t("screen.sharedWith", { workspaces: team.sharedWorkspaces.join(", ") })}</Text> : null}
            {!team.workspaceId ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{t("screen.workspaceMissing")}</Text> : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {team.workspaceId ? (
                <Button s={s} secondary label={t("screen.openTeam")} accessibilityLabel={t("screen.openTeamNamed", { workspace: team.orchestratorWorkspace })} onPress={() => openTeamPanel?.(team.workspaceId!)} />
              ) : (
                <Button s={s} label={t("screen.reconnect")} accessibilityLabel={t("screen.reconnectNamed", { workspace: team.orchestratorWorkspace })} disabled={reconnectBusy} onPress={() => { restored.reset(); setReconnecting(`${project.id}:${team.file}`); }} />
              )}
              <LinkButton
                label={t("screen.deleteTeam")}
                accessibilityLabel={t("screen.deleteTeamNamed", { workspace: team.orchestratorWorkspace })}
                color={theme.colors.foregroundMuted}
                disabled={deleted.isPending}
                onPress={() => setConfirming(`${project.id}:${team.file}`)}
                style={{ marginLeft: "auto" }}
              />
            </View>
            <Prompt
              open={!team.workspaceId && reconnecting === `${project.id}:${team.file}`}
              announce={t("screen.reconnectPick")}
              style={insetPanel}
              message={
                <>
                  <Text style={s.text}>{t("screen.reconnectPick")}</Text>
                  {!reconnectChoices(project.workspaces, project.teams, team).length ? <Text style={s.muted}>{t("screen.noWorkspaceToPick")}</Text> : null}
                </>
              }
            >
              <View style={s.row}>
                {reconnectChoices(project.workspaces, project.teams, team).map((workspace) => (
                  <Button key={workspace.id} s={s} label={workspace.title} disabled={reconnectBusy} onPress={() => reconnected.mutate({ projectId: project.id, file: team.file, workspaceId: workspace.id })} />
                ))}
                <Button s={s} secondary label={t("screen.startNewWorkspace")} disabled={reconnectBusy} onPress={() => restored.mutate({ projectId: project.id, file: team.file })} />
                <Button s={s} secondary label={t("review.cancel")} disabled={reconnectBusy} onPress={() => setReconnecting(null)} />
              </View>
              <Notice tone="status" announce={reconnectBusy ? t(restored.isPending ? "result.applying" : "loading") : ""} style={s.row}>
                {reconnectBusy ? <><ActivityIndicator color={theme.colors.accent} /><Text style={s.muted}>{t(restored.isPending ? "result.applying" : "loading")}</Text></> : null}
              </Notice>
              <Errors s={s} errors={restored.variables?.projectId === project.id && restored.variables.file === team.file ? [...(restored.error ? [String(restored.error)] : []), ...(restored.data && !restored.data.ok ? restored.data.errors : [])] : []} />
            </Prompt>
            <Prompt
              open={confirming === `${project.id}:${team.file}`}
              announce={t("screen.deleteConfirm", { file: team.file })}
              style={insetPanel}
              message={
                <>
                  <Text style={s.text}>{t("screen.deleteConfirm", { file: team.file })}</Text>
                  {team.sharedWorkspaces.length ? <Text style={s.text}>{t("screen.deleteShared", { workspaces: team.sharedWorkspaces.join(", ") })}</Text> : null}
                </>
              }
            >
              <View style={s.row}>
                <Button s={s} label={t("screen.deleteYes")} disabled={deleted.isPending} onPress={() => deleted.mutate({ projectId: project.id, file: team.file })} />
                <Button s={s} secondary label={t("review.cancel")} disabled={deleted.isPending} onPress={() => setConfirming(null)} />
              </View>
            </Prompt>
          </Group>
        ))}
      </View>
    );
  };

  const renderSection = ({ project, ids }: { project: (typeof agentSections)[number]["project"]; ids: string[] }) => (
                  <View key={project.id} style={[s.card, { minWidth: 0, padding: 0, gap: 0, overflow: "hidden" }]}>
                    {projectTitleBar(project)}
                    <AgentDashboardView
                      data={dashboard}
                      workspaceIds={ids}
                      rosterWorkspaceId={ids[0] ?? null}
                      state={dashState}
                      setState={setDashState}
                      colors={theme.colors}
                      compact={layout.compact}
                      open={navigation ? (id: string) => navigation.openAgent({ agentId: id }) : undefined}
                      embedded
                      activityFilter={activityFilter}
                      reportForest={(forest) => setForestByProject((current) => current[project.id] === forest ? current : { ...current, [project.id]: forest })}
                      expandedSubagents={expandedSubagents}
                      setExpandedSubagents={setExpandedSubagents}
                      width={widthByProject[project.id] ?? 0}
                      onWidth={(width) => setWidthByProject((current) => current[project.id] === width ? current : { ...current, [project.id]: width })}
                      reportClosed={(closed) => setClosedByProject((current) => current[project.id]?.join("\n") === closed.join("\n") ? current : { ...current, [project.id]: closed })}
                    />
                  </View>
  );
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Text accessibilityRole="header" style={[s.title, { fontSize: 20, fontWeight: "700" }]}>{t("screen.title")}</Text>
      <Tabs
        id={tabsId}
        label={t("screen.tabsLabel")}
        colors={theme.colors}
        value={tab}
        onChange={setTab}
        items={[
          { value: "teams", label: t("screen.tabTeams") },
          { value: "agents", label: t("screen.allAgents", { count: agentTotal }) },
        ]}
      />
      {projects.isLoading ? <Text style={s.muted}>{t("loading")}</Text> : null}
      <Errors s={s} errors={projects.error ? [String(projects.error)] : []} />
      <Notice tone="status" announce={advice.join(". ")} token={restored.submittedAt} style={{ gap: 4 }}>
        {advice.map((line) => <Text key={line} style={s.text}>{line}</Text>)}
      </Notice>
      {tab === "agents" ? (
        <TabPanel id={tabsId} value="agents" style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <RadioGroup
              variant="pill"
              label={t("screen.filterLabel")}
              colors={theme.colors}
              value={activityFilter}
              onChange={setActivityFilter}
              items={ACTIVITY_FILTERS.map((id) => ({ value: id, label: t(id === "all" ? "screen.filterAll" : `screen.${id}`, { count: counts[id] }) }))}
            />
            <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: 12 }}>
              <DensityToggle colors={theme.colors} state={dashState} setState={setDashState} />
              <View style={{ marginTop: -12 }}>
                <ClosedControls colors={theme.colors} state={dashState} setState={setDashState} closedIds={closedIds} pad={0} />
              </View>
            </View>
          </View>
          <Notice tone="status">
            {agentSections.length > 0 && shownSections.length === 0 && agentSections.every(({ project }) => forestByProject[project.id]) ? <Text style={s.muted}>{t("screen.noMatchingAgents")}</Text> : null}
          </Notice>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }} onLayout={(event) => {
            const width = Math.round(event.nativeEvent.layout.width);
            setListWidth((current) => current === width ? current : width);
          }}>
            {sectionColumns.map((column, index) => (
              <View key={index} style={{ flex: 1, minWidth: 0, gap: 12 }}>
                {column.map(renderSection)}
              </View>
            ))}
          </View>
          {hiddenSections.length ? <View style={{ display: "none" }}>{hiddenSections.map(renderSection)}</View> : null}
        </TabPanel>
      ) : null}
      {tab === "teams" ? <TabPanel id={tabsId} value="teams" style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }} onLayout={(event) => {
        const width = Math.round(event.nativeEvent.layout.width);
        setListWidth((current) => current === width ? current : width);
      }}>
        {teamColumns.map((column, index) => (
          <View key={index} style={{ flex: 1, minWidth: 0, gap: 12 }}>
            {column.map(renderProject)}
          </View>
        ))}
      </View>
      {emptyProjects.length ? (
        <View style={[s.card, { padding: 0, gap: 0, overflow: "hidden" }]}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 12, paddingVertical: 10 }}>
            <Text style={[s.text, { fontWeight: "600" }]}>{t("screen.emptyProjects")}</Text>
            <Text style={s.muted}>{emptyProjects.length}</Text>
          </View>
          {emptyProjects.map((project) => (
            <View key={project.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              <Text style={[s.text, { fontSize: 13, fontWeight: "600" }]}>{project.name}</Text>
              <Text style={[s.muted, { flex: 1, minWidth: 0 }]} numberOfLines={1}>{project.root}</Text>
              {newTeamLink(project)}
            </View>
          ))}
        </View>
      ) : null}
      </TabPanel> : null}
    </ScrollView>
  );
}
