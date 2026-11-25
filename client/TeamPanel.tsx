import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { withFreeWorkspaces } from "../shared/apply-plan";
import { blankOrchestratorModel, effortChoices, latestResult, noticesOf, outcomeToken, pendingPickup, pollPhase, proposalPollInterval, reservedByOtherTeam } from "./panel-logic";
import { foldersText, newRole, parseFolders } from "../shared/draft";
import { EMPTY_HISTORY, record, undo, redo, type DraftHistory } from "../shared/draft-history";
import { messages } from "./i18n";
import { Button, Errors, Field, Group, Notice, Prompt, useFocusRing, webAria } from "./ui/controls";
import { PickerModal, type SelectRequest } from "./ui/Picker";
import { styles, type Colors, type Styles } from "./ui/styles";
import { teamApplyRpc, teamInstructionsImproveRpc, teamInstructionsProposalRpc, teamPendingProposalRpc, teamPlannerCancelRpc, teamProposalCancelRpc, teamProposalRpc, teamProposeRpc, teamReadRpc, teamRestartOrchestratorRpc, teamEditProposalRpc, teamEditProposeRpc, teamShareRpc, teamUnshareRpc } from "../shared/rpc";
import { checkTeam, type Role, type Team } from "../shared/team";
import { applyTeamEdit, summarizeTeamEdit } from "../shared/team-edit";
import { providerIcon } from "../shared/provider-icons";
import { copyTeamTo, isSharedWith, TEAMS_DIR, workspaceClashes } from "../shared/team-files";
import { validateTeam, type ProviderInfo } from "../shared/validate";

const SelectContext = createContext<(request: SelectRequest) => void>(() => {});

function Select({ s, label, options, value, onChange, compact }: { s: Styles; label: string; options: readonly string[]; value: string; onChange(value: string): void; compact?: boolean }) {
  const openSelect = useContext(SelectContext);
  const focus = useFocusRing(s.colors);
  const trigger = useRef<View>(null);
  return (
    <Pressable
      ref={trigger}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value || "—"}`}
      {...webAria({ "aria-haspopup": "dialog" })}
      onPress={() => openSelect({ label, options, value, onChange, restoreFocus: () => trigger.current?.focus() })}
      {...focus.handlers}
      style={[compact ? s.selectCompact : s.select, focus.ring]}
    >
      <Text style={[s.text, compact ? { fontSize: 12 } : null]} numberOfLines={1}>{value || "—"}</Text>
      <Text aria-hidden style={[s.muted, { fontSize: 10 }]}>▾</Text>
    </Pressable>
  );
}

/** Provider and model pickers limited to what this host can run. */
function ModelPicker({ s, catalog, provider, model, onChange, extra }: { s: Styles; catalog: readonly ProviderInfo[]; provider: string; model: string; onChange(next: { provider: string; model: string }): void; extra?: ReactNode }) {
  const { t } = useTranslation(messages);
  const ready = catalog.filter((entry) => entry.ready);
  const models = ready.find((entry) => entry.id === provider)?.models.map((entry) => entry.id) ?? [];
  return (
    <View style={s.row}>
      <Text style={s.label}>{t("role.providerAndModel")}</Text>
      <Select
        s={s}
        compact
        label={t("role.provider")}
        options={ready.map((entry) => entry.id)}
        value={provider}
        onChange={(next) => {
          if (next !== provider) onChange({ provider: next, model: ready.find((entry) => entry.id === next)?.models[0]?.id ?? "" });
        }}
      />
      <Select s={s} compact label={t("role.model")} options={models} value={model} onChange={(next) => onChange({ provider, model: next })} />
      {extra}
    </View>
  );
}

/** The entity with the new provider and model; its effort is kept only when the new model offers it, so the key is dropped otherwise. */
function withModel<T extends { effort?: string }>(catalog: readonly ProviderInfo[], entity: T, next: { provider: string; model: string }): T {
  const efforts = catalog.find((entry) => entry.id === next.provider)?.models.find((entry) => entry.id === next.model)?.efforts ?? [];
  const { effort, ...rest } = entity;
  return { ...rest, ...next, ...(effort && efforts.some((option) => option.id === effort) ? { effort } : {}) } as unknown as T;
}

/** The entity with the effort set, or without the key when it is undefined (the model's default). */
function withEffort<T extends { effort?: string }>(entity: T, effort: string | undefined): T {
  const { effort: _previous, ...rest } = entity;
  return (effort ? { ...rest, effort } : rest) as T;
}

/** Effort picker for the selected model: the model's default first, then its efforts; hidden when the model has none and no effort is set. */
function EffortPicker({ s, catalog, provider, model, effort, onChange }: { s: Styles; catalog: readonly ProviderInfo[]; provider: string; model: string; effort: string | undefined; onChange(effort: string | undefined): void }) {
  const { t } = useTranslation(messages);
  const info = catalog.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model);
  const efforts = effortChoices(info?.efforts ?? [], effort);
  if (!efforts.length) return null;
  const labelOf = (id: string) => efforts.find((option) => option.id === id)?.label ?? id;
  const defaultOption = t("role.effortDefault", { effort: info?.defaultEffort ? labelOf(info.defaultEffort) : "—" });
  return (
    <>
      <Text style={s.label}>{t("role.effort")}</Text>
      <Select
        s={s}
        compact
        label={t("role.effort")}
        options={[defaultOption, ...efforts.map((option) => option.label)]}
        value={effort ? labelOf(effort) : defaultOption}
        onChange={(next) => onChange(next === defaultOption ? undefined : efforts.find((option) => option.label === next)?.id)}
      />
    </>
  );
}

function RoleEditor({ s, role, catalog, onChange, onEditInstructions, onRemove }: { s: Styles; role: Role; catalog: readonly ProviderInfo[]; onChange(role: Role): void; onEditInstructions(): void; onRemove(): void }) {
  const { t } = useTranslation(messages);
  const [folders, setFolders] = useState(foldersText(role.folders));
  const [showFolders, setShowFolders] = useState(role.folders.length > 0);
  const currentName = useRef(role.name);
  // Keyed by position, so resync when another role's removal hands this editor a different role.
  useEffect(() => {
    const switched = role.name !== currentName.current;
    currentName.current = role.name;
    if (switched || foldersText(parseFolders(folders)) !== foldersText(role.folders)) {
      setFolders(foldersText(role.folders));
      setShowFolders(role.folders.length > 0);
    }
  }, [role.name, role.folders]);
  const foldersExpanded = showFolders || role.folders.length > 0;
  const roleName = role.name.trim() || t("role.name");
  return (
    <Group label={roleName} style={[s.card, s.roleCard, { padding: 12, gap: 10 }]}>
      <View style={{ gap: 4 }}>
        <Text style={s.label}>{t("role.name")}</Text>
        <View style={s.row}>
          <Field
            label={t("role.name")}
            labelHidden
            style={[s.inputCompact, { flex: 1, minWidth: 0, fontWeight: "600" }]}
            value={role.name}
            placeholder={t("role.name")}
            onChangeText={(name) => {
              currentName.current = name;
              onChange({ ...role, name });
            }}
          />
          <Button s={s} compact secondary label={t("role.remove")} accessibilityLabel={t("role.removeNamed", { role: roleName })} onPress={onRemove} />
        </View>
      </View>
      <ModelPicker s={s} catalog={catalog} provider={role.provider} model={role.model} onChange={(next) => onChange(withModel(catalog, role, next))} extra={<EffortPicker s={s} catalog={catalog} provider={role.provider} model={role.model} effort={role.effort} onChange={(effort) => onChange(withEffort(role, effort))} />} />
      {foldersExpanded ? (
        <Field
          label={t("role.folders")}
          labelStyle={s.label}
          style={s.inputCompact}
          value={folders}
          placeholder={t("role.folders")}
          onChangeText={(text) => {
            setFolders(text);
            onChange({ ...role, folders: parseFolders(text) });
          }}
        />
      ) : (
        <View style={s.row}>
          <Button s={s} compact secondary label={t("role.setFolders")} onPress={() => setShowFolders(true)} />
        </View>
      )}
      <View style={[s.divider, { gap: 4, paddingTop: 10 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Text style={s.label}>{t("role.instructions")}</Text>
          <Button s={s} compact secondary label={t("role.editInstructions")} accessibilityLabel={t("role.editInstructionsNamed", { role: roleName })} onPress={onEditInstructions} />
        </View>
        {role.instructions.trim() ? (
          <Text numberOfLines={3} style={s.text}>{role.instructions.trim()}</Text>
        ) : (
          <Text style={s.muted}>{t("role.noInstructions")}</Text>
        )}
      </View>
    </Group>
  );
}

/** The server archives an edit or instructions planner once it answers; never ask it again on focus or reconnect. */
const SETTLED_ONCE = { refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

/** Where the team goes: a workspace's project, or a project picked without a workspace. */
type Target = { workspaceId: string } | { projectId: string };

function InstructionsDialog({
  s,
  accentColor,
  target,
  team,
  role,
  onSave,
  onClose,
}: {
  s: Styles;
  accentColor: string;
  target: Target;
  team: Team | null;
  role: Role | null;
  onSave(instructions: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const improve = useRpc(teamInstructionsImproveRpc);
  const instructionsProposal = useRpc(teamInstructionsProposalRpc);
  const cancelPlanner = useRpc(teamPlannerCancelRpc);
  const stopPlanner = (agentId: string) => void cancelPlanner({ agentId }).catch(() => {});
  const open = role !== null && team !== null;
  const [instructions, setInstructions] = useState("");
  const [request, setRequest] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [plannerId, setPlannerId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const requestCounter = useRef(0);

  // Forget the planner and archive it if one is still tracked, so a closed dialog stops spending tokens.
  const stopTracking = () => {
    requestCounter.current += 1;
    setStarting(false);
    setStartError(null);
    if (plannerId) stopPlanner(plannerId);
    setPlannerId(null);
  };

  // Unmounting (workspace switch, back to projects) skips the close path, so the planner is archived here, also one whose start answers late.
  const unmount = useRef(() => {});
  unmount.current = () => {
    requestCounter.current += 1;
    if (plannerId) stopPlanner(plannerId);
  };
  useEffect(() => () => unmount.current(), []);

  useEffect(() => {
    if (!open || !role) {
      stopTracking();
      return;
    }
    stopTracking();
    setInstructions(role.instructions);
    setRequest("");
    setSuggestion(null);
  }, [open]);

  const planning = useQuery({
    queryKey: ["workspace-agents", "instructions-proposal", plannerId],
    queryFn: () => instructionsProposal({ agentId: plannerId! }),
    enabled: plannerId !== null,
    refetchInterval: (query) => proposalPollInterval(query.state),
    ...SETTLED_ONCE,
  });

  useEffect(() => {
    if (planning.data?.status !== "done") return;
    setSuggestion(planning.data.instructions);
    setPlannerId(null);
  }, [planning.data]);

  const startImprove = useMutation({
    onMutate: () => {
      const currentRequest = ++requestCounter.current;
      setStarting(true);
      setStartError(null);
      if (plannerId) stopPlanner(plannerId);
      setPlannerId(null);
      setSuggestion(null);
      return { request: currentRequest };
    },
    mutationFn: ({ currentRole, currentTeam, currentInstructions, currentRequest }: { currentRole: Role; currentTeam: Team; currentInstructions: string; currentRequest: string }) =>
      improve({
        ...target,
        role: { name: currentRole.name, folders: currentRole.folders, instructions: currentInstructions },
        request: currentRequest,
        team: {
          goal: currentTeam.goal,
          orchestratorWorkspace: currentTeam.orchestrator.workspace,
          roles: currentTeam.roles.map(({ name, folders }) => ({ name, folders })),
        },
      }),
    onSuccess: ({ agentId }, _vars, context) => {
      if (requestCounter.current !== context.request) return stopPlanner(agentId);
      setStarting(false);
      setPlannerId(agentId);
    },
    onError: (error, _vars, context) => {
      if (requestCounter.current !== context?.request) return;
      setStarting(false);
      setStartError(String(error));
    },
  });

  const busy = starting || (plannerId !== null && !planning.isError && planning.data?.status !== "failed");

  const close = () => {
    stopTracking();
    setSuggestion(null);
    setRequest("");
    onClose();
  };

  return (
    <Modal
      title={t("role.instructionsTitle", { role: role?.name.trim() || t("role.name") })}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <Modal.Content>
        {open && role && team ? (
          <>
            <Field
              label={t("role.instructions")}
              labelHidden
              style={[s.input, { minHeight: 120, textAlignVertical: "top" }]}
              value={instructions}
              placeholder={t("role.instructions")}
              multiline
              onChangeText={setInstructions}
            />
            <Prompt open={suggestion !== null} announce={suggestion ?? ""} message={<Text style={s.text}>{suggestion}</Text>} style={s.card}>
              <View style={s.row}>
                <Button
                  s={s}
                  label={t("role.applySuggestion")}
                  onPress={() => {
                    if (suggestion !== null) setInstructions(suggestion);
                    setSuggestion(null);
                  }}
                />
                <Button s={s} secondary label={t("role.discardSuggestion")} onPress={() => setSuggestion(null)} />
              </View>
            </Prompt>
            <View style={s.card}>
              <Field
                label={t("role.improveRequestPlaceholder")}
                labelHidden
                style={s.input}
                value={request}
                placeholder={t("role.improveRequestPlaceholder")}
                multiline
                onChangeText={setRequest}
              />
              <View style={s.row}>
                <Button
                  s={s}
                  secondary
                  label={t("role.improveWithAi")}
                  disabled={busy}
                  onPress={() => startImprove.mutate({ currentRole: role, currentTeam: team, currentInstructions: instructions, currentRequest: request })}
                />
                <Notice tone="status" announce={busy ? t("role.instructionsPlanning") : ""} style={s.row}>
                  {busy ? (
                    <>
                      <ActivityIndicator color={accentColor} />
                      <Text style={s.muted}>{t("role.instructionsPlanning")}</Text>
                    </>
                  ) : null}
                </Notice>
              </View>
              <Errors s={s} errors={[...(planning.data?.status === "failed" ? planning.data.errors : []), ...(planning.error ? [String(planning.error)] : []), ...(startError ? [startError] : [])]} />
            </View>
            <View style={s.row}>
              <Button s={s} secondary label={t("review.cancel")} onPress={close} />
              <Button
                s={s}
                label={t("role.saveInstructions")}
                onPress={() => {
                  onSave(instructions);
                  close();
                }}
              />
            </View>
          </>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

function TeamModel({ provider, model, effort, colors, icons }: { provider: string; model: string; effort?: string; colors: Colors; icons: Map<string, string | undefined> }) {
  const icon = providerIcon(provider, icons.get(provider));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1 }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" }}>
        {icon.kind === "svg" ? <Icon icon={{ svg: icon.svg }} size={14} color={colors.foreground} /> : <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 12 }}>{icon.letter}</Text>}
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{effort ? `${model} · ${effort}` : model}</Text>
    </View>
  );
}

function CurrentTeamTree({ team, s, colors, compact, icons }: { team: Team; s: Styles; colors: Colors; compact: boolean; icons: Map<string, string | undefined> }) {
  const { t } = useTranslation(messages);
  const [width, setWidth] = useState(0);
  const stacked = compact || width < 560;
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "center", gap: stacked ? 12 : 0 }}>
      <View style={[s.orchestratorCard, { gap: 8, minWidth: 0, ...(stacked ? {} : { width: 200 }) }]}>
        <Text style={s.orchestratorLabel}>{t("review.orchestrator")}</Text>
        <Text style={s.itemTitle}>{team.orchestrator.workspace}</Text>
        <TeamModel {...team.orchestrator} colors={colors} icons={icons} />
      </View>
      {!stacked && team.roles.length > 0 ? <View style={{ width: 20, height: 2, backgroundColor: colors.border }} /> : null}
      <View style={{ flex: stacked ? undefined : 1, minWidth: 0, marginLeft: stacked ? 12 : 0 }}>
        {team.roles.map((role, index) => (
          <View key={role.name} style={{ flexDirection: "row", alignItems: "stretch" }}>
            <View style={{ width: 18 }}>
              <View style={{ position: "absolute", left: 0, top: index === 0 ? "50%" : 0, bottom: index === team.roles.length - 1 ? "50%" : 0, width: 2, backgroundColor: colors.border }} />
              <View style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 2, backgroundColor: colors.border }} />
            </View>
            <View style={{ flex: 1, minWidth: 0, paddingVertical: 4 }}>
              <View style={[s.card, { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, minHeight: 44, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: colors.surface0 }]}>
                <Text style={[s.itemTitle, { minWidth: 84, maxWidth: "100%", flexShrink: 1 }]}>{role.name}</Text>
                <TeamModel provider={role.provider} model={role.model} effort={role.effort} colors={colors} icons={icons} />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, minWidth: 0, flexShrink: 1 }}>
                  {(role.folders.length ? role.folders.slice(0, 3) : [t("current.noFolderLimit")]).map((folder, at) => (
                    <View key={at} style={s.chip}>
                      <Text style={s.muted}>{folder}</Text>
                    </View>
                  ))}
                  {role.folders.length > 3 ? <View style={s.chip}><Text style={s.muted}>{t("current.moreFolders", { count: role.folders.length - 3 })}</Text></View> : null}
                </View>
              </View>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

type Applied = Extract<RpcOutput<typeof teamApplyRpc>, { ok: true }>;

export const PROJECT_TEAMS_KEY = ["workspace-agents", "projects"] as const;

export function TeamPanel({ workspaceId, ...props }: PluginWorkspacePanelProps) {
  return <TeamEditor key={workspaceId} {...props} target={{ workspaceId }} />;
}

/** Propose, review and apply a team for the target's project. */
export function TeamEditor({ theme, layout, navigation, target, onApplied }: Pick<PluginScreenProps, "theme" | "layout" | "navigation"> & { target: Target; onApplied?(result: Applied): void }) {
  const s = useMemo(() => styles(theme.colors, layout.compact), [theme, layout.compact]);
  const { t } = useTranslation(messages);
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  const providers = useQuery({ queryKey: ["dashboard", "providers"], queryFn: () => paseo.providers.snapshot() });
  const providerIcons = useMemo(() => new Map((providers.data?.entries ?? []).map((provider) => [provider.provider, provider.iconSvg])), [providers.data]);
  const read = useRpc(teamReadRpc);
  const propose = useRpc(teamProposeRpc);
  const proposal = useRpc(teamProposalRpc);
  const apply = useRpc(teamApplyRpc);
  const restartOrchestrator = useRpc(teamRestartOrchestratorRpc);
  const share = useRpc(teamShareRpc);
  const unshare = useRpc(teamUnshareRpc);
  const proposeTeamEdit = useRpc(teamEditProposeRpc);
  const teamEditProposal = useRpc(teamEditProposalRpc);
  const pendingProposal = useRpc(teamPendingProposalRpc);
  const cancelProposal = useRpc(teamProposalCancelRpc);
  const cancelPlanner = useRpc(teamPlannerCancelRpc);
  const stopPlanner = (agentId: string) => void cancelPlanner({ agentId }).catch(() => {});

  const current = useQuery({ queryKey: ["workspace-agents", "team", target], queryFn: () => read(target) });
  const [goal, setGoal] = useState("");
  const [plannerId, setPlannerId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Team | null>(null);
  const [history, setHistory] = useState<DraftHistory>(EMPTY_HISTORY);
  const [editNotice, setEditNotice] = useState<{
    summary: ReturnType<typeof summarizeTeamEdit>;
    validation: Extract<RpcOutput<typeof teamEditProposalRpc>, { status: "done" }>["validation"];
  } | null>(null);
  const appliedEditId = useRef<string | null>(null);
  const resetEditHistory = () => {
    setHistory(EMPTY_HISTORY);
    setEditNotice(null);
  };
  const [editingRoleIndex, setEditingRoleIndex] = useState<number | null>(null);
  const [roleGroupWidth, setRoleGroupWidth] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmUnshare, setConfirmUnshare] = useState(false);
  const [picker, setPicker] = useState<SelectRequest | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const showMessages = () => scrollRef.current?.scrollToEnd({ animated: true });

  // The planner keeps running when this screen closes; reopening it picks the newest proposal back up.
  // Fetched fresh on every open (gcTime 0) and only once the team is read, since a proposal is fitted to it.
  const pendingKey = ["workspace-agents", "pending-proposal", target];
  const pending = useQuery({ queryKey: pendingKey, queryFn: () => pendingProposal(target), enabled: current.data !== undefined && !current.data.team, gcTime: 0 });
  const cancelled = useMutation({ mutationFn: () => cancelProposal(target), onSuccess: () => queryClient.setQueryData(pendingKey, { agentId: null }) });

  const planning = useQuery({
    queryKey: ["workspace-agents", "proposal", plannerId],
    queryFn: () => proposal({ agentId: plannerId! }),
    enabled: plannerId !== null,
    refetchInterval: (query) => proposalPollInterval(query.state),
    ...SETTLED_ONCE,
  });
  // From a workspace, the team's orchestrator always runs in that workspace.
  const here = current.data?.workspace ?? null;
  const atHere = (team: Team): Team => (here === null ? team : { ...team, orchestrator: { ...team.orchestrator, workspace: here } });
  // A new draft creates new workspaces instead of landing in the project's existing ones or in another team's missing one.
  const titles = [...(current.data?.projectWorkspaces ?? []), ...(current.data?.takenWorkspaces ?? [])];
  const fresh = (team: Team): Team => withFreeWorkspaces(atHere(team), titles, { orchestrator: here === null });
  // Each proposal becomes the draft once; a later refetch of the same answer must not wipe the user's edits.
  const draftedProposalId = useRef<string | null>(null);
  useEffect(() => {
    if (planning.data?.status !== "done" || !plannerId || draftedProposalId.current === plannerId) return;
    draftedProposalId.current = plannerId;
    resetEditHistory();
    cancelTeamEdit();
    setDraft(fresh(planning.data.team));
  }, [planning.data, plannerId]);

  // Keep AI edits separate from the draft until accepted; cancellation archives the editor, also one whose start answers late.
  const [editRequest, setEditRequest] = useState("");
  const [editPlannerId, setEditPlannerId] = useState<string | null>(null);
  const [editStarting, setEditStarting] = useState(false);
  const [editStartError, setEditStartError] = useState<string | null>(null);
  const editRequestCounter = useRef(0);
  const cancelTeamEdit = () => {
    editRequestCounter.current += 1;
    setEditStarting(false);
    setEditStartError(null);
    if (editPlannerId) stopPlanner(editPlannerId);
    setEditPlannerId(null);
    setEditNotice(null);
  };
  // Unmounting (workspace switch, back to projects, sidebar badge) never reaches cancelTeamEdit, so the editor is archived here.
  const unmount = useRef(() => {});
  unmount.current = () => {
    editRequestCounter.current += 1;
    if (editPlannerId) stopPlanner(editPlannerId);
  };
  useEffect(() => () => unmount.current(), []);
  const editPlanning = useQuery({
    queryKey: ["workspace-agents", "team-edit-proposal", editPlannerId],
    queryFn: () => teamEditProposal({ agentId: editPlannerId! }),
    enabled: editPlannerId !== null,
    refetchInterval: (query) => proposalPollInterval(query.state),
    ...SETTLED_ONCE,
  });
  const startTeamEdit = useMutation({
    onMutate: () => {
      const request = ++editRequestCounter.current;
      if (editPlannerId) stopPlanner(editPlannerId);
      setEditPlannerId(null);
      setEditNotice(null);
      setEditStarting(true);
      setEditStartError(null);
      return { request };
    },
    mutationFn: (team: Team) =>
      proposeTeamEdit({ ...target, request: editRequest, team }),
    onSuccess: ({ agentId }, _team, context) => {
      if (editRequestCounter.current !== context.request) return stopPlanner(agentId);
      setEditStarting(false);
      setEditPlannerId(agentId);
    },
    onError: (error, _team, context) => {
      if (editRequestCounter.current !== context?.request) return;
      setEditStarting(false);
      setEditStartError(String(error));
    },
  });
  // A failed poll has stopped: the editor stays tracked (so Cancel can archive it) but is no longer waited on.
  const editPhase = pollPhase(editPlannerId, editPlanning);
  const editBusy = editStarting || editPhase !== "idle";

  useEffect(() => {
    const result = editPlanning.data;
    if (!draft || !editPlannerId || result?.status !== "done" || appliedEditId.current === editPlannerId) return;
    appliedEditId.current = editPlannerId;
    const after = applyTeamEdit(draft, result.team);
    setHistory((current) => record(current, draft));
    setDraft(after);
    setEditNotice({ summary: summarizeTeamEdit(draft, after), validation: result.validation });
    setEditRequest("");
    setEditPlannerId(null);
  }, [draft, editPlannerId, editPlanning.data]);
  const editSummary = editNotice?.summary;

  // A draft started by hand, or leaving the review, drops a proposal whose start is still in flight.
  const startCounter = useRef(0);
  const beginDraft = (team: Team) => {
    startCounter.current += 1;
    resetEditHistory();
    cancelTeamEdit();
    setDraft(team);
  };
  const closeReview = () => {
    startCounter.current += 1;
    draftedProposalId.current = null;
    cancelTeamEdit();
    resetEditHistory();
    setEditRequest("");
    setPicker(null);
    setEditingRoleIndex(null);
    setDraft(null);
    setPlannerId(null);
  };
  const start = useMutation({
    onMutate: () => {
      resetEditHistory();
      cancelTeamEdit();
      return { request: ++startCounter.current };
    },
    mutationFn: () => propose({ ...target, goal }),
    onSuccess: ({ agentId }, _input, context) => (startCounter.current === context.request ? setPlannerId(agentId) : stopPlanner(agentId)),
  });
  const applied = useMutation({
    onMutate: () => unshared.reset(),
    mutationFn: (team: Team) => apply({ ...target, team }),
    onSuccess: (result) => {
      void current.refetch();
      void queryClient.invalidateQueries({ queryKey: PROJECT_TEAMS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "roster"] });
      if (!result.ok) return;
      // Apply archived the planner; leave the review so the applied team's card shows instead of a second Apply.
      queryClient.setQueryData(pendingKey, { agentId: null });
      closeReview();
      onApplied?.(result);
    },
  });
  const targetWorkspaceId = "workspaceId" in target ? target.workspaceId : null;
  const refreshTeams = () => {
    void current.refetch();
    void queryClient.invalidateQueries({ queryKey: PROJECT_TEAMS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "agents"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "roster"] });
  };
  // Share the project's team with this workspace: the file lists it, and the team's orchestrator starts here.
  const shared = useMutation({
    onMutate: () => {
      // Sharing gives this workspace a team, so a proposal whose start answers late is dropped.
      startCounter.current += 1;
      unshared.reset();
    },
    mutationFn: (file: string) => share({ projectId: current.data!.project.id, file, workspaceId: targetWorkspaceId! }),
    onSuccess: (result) => {
      refreshTeams();
      if (result.ok) onApplied?.(result);
    },
  });
  useEffect(() => {
    // A leftover planner is picked up only while nothing is being drafted, started or shared; a start that then fails lets it in.
    const agentId = pendingPickup(pending.data?.agentId, { hasTeam: Boolean(current.data?.team), drafting: draft !== null, starting: start.isPending, sharing: shared.isPending });
    if (agentId) setPlannerId((id) => id ?? agentId);
  }, [pending.data, start.isPending]);
  const unshared = useMutation({
    mutationFn: () => unshare({ projectId: current.data!.project.id, file: current.data!.file!, workspaceId: targetWorkspaceId! }),
    onSuccess: (result) => {
      if (!result.ok) return;
      setConfirmUnshare(false);
      // The team left this workspace: an earlier Applied card would point at the orchestrator unshare just archived.
      shared.reset();
      applied.reset();
      refreshTeams();
    },
  });
  const restarted = useMutation({
    mutationFn: () => restartOrchestrator(target),
    onSuccess: () => {
      void current.refetch();
      void queryClient.invalidateQueries({ queryKey: PROJECT_TEAMS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "agents"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "roster"] });
    },
  });

  const catalog = current.data?.catalog ?? [];
  const checked = draft ? checkTeam(draft) : null;
  const problems = draft && checked?.ok ? [...validateTeam(checked.team, catalog), ...workspaceClashes(checked.team, current.data?.takenWorkspaces ?? [])].map((error) => `${error.target}: ${error.message}`) : (checked && !checked.ok ? checked.errors : []);
  const updateRole = (index: number, role: Role) => setDraft((current) => (current ? { ...current, roles: current.roles.map((entry, at) => (at === index ? role : entry)) } : current));
  const columns = roleGroupWidth < 640 ? 1 : roleGroupWidth < 1000 ? 2 : 3;
  const roleRows: { role: Role; index: number }[][] = [];
  if (draft) {
    for (let i = 0; i < draft.roles.length; i += columns) {
      roleRows.push(draft.roles.slice(i, i + columns).map((role, offset) => ({ role, index: i + offset })));
    }
  }
  const teamPhase = pollPhase(plannerId, planning);
  const cancelProposalPoll = () => {
    cancelled.mutate();
    setPlannerId(null);
  };
  // `busy` is false once a poll has failed: the dialog then only shows the error and Cancel.
  const progress = applied.isPending
    ? { title: t("progress.title"), status: t("result.applying"), busy: true, error: null, onCancel: null }
    : editBusy
      ? { title: t(editPhase === "errored" ? "review.editTeamWithAi" : "progress.title"), status: t("review.editPlanning"), busy: editPhase !== "errored", error: editPlanning.error ? String(editPlanning.error) : null, onCancel: cancelTeamEdit }
      : teamPhase !== "idle"
        ? { title: t(teamPhase === "errored" ? "create.propose" : "progress.title"), status: t("create.planning"), busy: teamPhase !== "errored", error: planning.error ? String(planning.error) : null, onCancel: cancelProposalPoll }
        : null;

  if (current.isLoading) return <View style={[s.screen, s.body]}><Text style={s.muted}>{t("loading")}</Text></View>;
  if (current.error) return <View style={[s.screen, s.body]}><Text style={s.danger}>{String(current.error)}</Text></View>;
  const data = current.data!;
  // Apply and Share both end in a started orchestrator; show the newer one's outcome.
  const outcome = latestResult(applied, shared);
  const result = outcome?.ok ? outcome : null;
  const cleanupLines = (result?.cleanup ?? []).map((failure) => t("result.cleanupFailed", { failure }));
  // Advice that is not a failure, such as an orchestrator elsewhere that still runs on the old team.
  const notices = noticesOf(result);
  // What failed, per action, so a repeat of the same failure is announced and scrolled to again.
  const failures = [
    { from: cancelled, errors: cancelled.error ? [String(cancelled.error)] : [] },
    { from: applied, errors: [...(applied.error ? [String(applied.error)] : []), ...(applied.data && !applied.data.ok ? applied.data.errors : [])] },
    { from: restarted, errors: [...(restarted.error ? [String(restarted.error)] : []), ...(restarted.data && !restarted.data.ok ? restarted.data.errors : [])] },
    // Unsharing closes its confirmation box, so what it could not archive or notify is reported here.
    { from: unshared, errors: unshared.data?.ok ? unshared.data.failures : [] },
  ];
  const reserved = reservedByOtherTeam(data.workspace, data.team !== null, data.takenWorkspaces);
  // This workspace uses a team whose home is elsewhere: it can stop sharing instead of deleting.
  const sharedHere = Boolean(data.team && data.workspace !== null && !data.home && isSharedWith(data.team, data.workspace));

  return (
    <ScrollView ref={scrollRef} style={s.screen} contentContainerStyle={s.body}>
      <View style={{ gap: 2 }}>
        <Text accessibilityRole="header" style={s.title}>{t("title", { project: data.project.name })}</Text>
        <Text style={s.muted}>{data.project.root}/{data.file ?? `${TEAMS_DIR}/`}</Text>
      </View>

      {data.errors.map((error) => <Text key={error} style={s.danger}>{error}</Text>)}
      {data.team && !draft ? (
        <View style={[s.card, { maxWidth: 960, width: "100%", alignSelf: "flex-start" }]}>
          {data.sharedWorkspaces.length && data.workspace !== null ? (
            <Text style={s.muted}>
              {data.home
                ? t("current.sharedWithHome", { workspaces: data.sharedWorkspaces.join(", ") })
                : t("current.sharedTeam", { home: data.team.orchestrator.workspace, count: data.sharedWorkspaces.length + 1 })}
            </Text>
          ) : null}
          <View style={{ gap: 4, alignItems: "flex-end" }}>
            <View style={[s.row, { justifyContent: "flex-end" }]}>
              <Button s={s} label={t("current.edit")} onPress={() => beginDraft(data.team!)} />
              <Button s={s} secondary label={t("current.reapply")} disabled={applied.isPending || restarted.isPending} onPress={() => applied.mutate(data.team!)} />
              <Button s={s} secondary label={t("current.restart")} disabled={applied.isPending || restarted.isPending} onPress={() => setConfirmRestart(true)} />
              {sharedHere ? <Button s={s} secondary label={t("current.unshare")} disabled={unshared.isPending} onPress={() => setConfirmUnshare(true)} /> : null}
            </View>
            <Text style={[s.muted, { textAlign: "right" }]}>{t("current.restartHint")}</Text>
          </View>
          {sharedHere && confirmUnshare ? (
            <View style={s.inset}>
              <Text style={s.text}>{t("current.unshareConfirm", { home: data.team.orchestrator.workspace })}</Text>
              <View style={s.row}>
                <Button s={s} label={t("current.unshare")} disabled={unshared.isPending} onPress={() => unshared.mutate()} />
                <Button s={s} secondary label={t("review.cancel")} disabled={unshared.isPending} onPress={() => setConfirmUnshare(false)} />
              </View>
              <Errors s={s} errors={[...(unshared.error ? [String(unshared.error)] : []), ...(unshared.data && !unshared.data.ok ? unshared.data.errors : [])]} />
            </View>
          ) : null}
          <CurrentTeamTree team={data.team} s={s} colors={theme.colors} compact={layout.compact} icons={providerIcons} />
          {data.validation.map((error) => <Text key={error.target + error.message} style={s.danger}>{error.target}: {error.message}</Text>)}
        </View>
      ) : null}

      <Modal
        title={progress?.title ?? t("progress.title")}
        open={progress !== null}
        onOpenChange={(open) => {
          if (!open) progress?.onCancel?.();
        }}
      >
        <Modal.Content>
          <Notice tone="status" announce={progress?.busy ? progress.status : ""} style={s.row}>
            {progress?.busy ? (
              <>
                <ActivityIndicator color={theme.colors.accent} />
                <Text style={s.text}>{progress.status}</Text>
              </>
            ) : null}
          </Notice>
          {progress?.busy ? <Text style={s.muted}>{t("progress.keepOpen")}</Text> : null}
          <Errors s={s} errors={progress?.error ? [progress.error] : []} />
          {progress?.onCancel ? (
            <View style={s.row}>
              <Button s={s} secondary label={t("review.cancel")} onPress={progress.onCancel} />
            </View>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal title={t("current.restartConfirmTitle")} open={confirmRestart} onOpenChange={setConfirmRestart}>
        <Modal.Content>
          <Text style={s.text}>{t("current.restartConfirmBody")}</Text>
          <View style={s.row}>
            <Button s={s} secondary label={t("review.cancel")} disabled={restarted.isPending} onPress={() => setConfirmRestart(false)} />
            <Button
              s={s}
              label={t("current.restartConfirm")}
              disabled={restarted.isPending}
              onPress={() => {
                setConfirmRestart(false);
                restarted.mutate();
              }}
            />
          </View>
        </Modal.Content>
      </Modal>

      <PickerModal s={s} request={picker} onClose={() => setPicker(null)} />

      <InstructionsDialog
        s={s}
        accentColor={theme.colors.accent}
        target={target}
        team={draft}
        role={editingRoleIndex !== null && draft ? draft.roles[editingRoleIndex] ?? null : null}
        onSave={(instructions) => {
          if (editingRoleIndex !== null && draft?.roles[editingRoleIndex]) {
            updateRole(editingRoleIndex, { ...draft.roles[editingRoleIndex]!, instructions });
          }
        }}
        onClose={() => setEditingRoleIndex(null)}
      />

      {!draft ? data.team ? null : reserved ? (
        <Notice tone="status" style={s.card}>
          <Text style={s.text}>{t("create.reservedByOtherTeam")}</Text>
        </Notice>
      ) : (
        <View style={s.card}>
          <Text style={s.text}>{t(here === null ? "create.intro" : "create.introHere")}</Text>
          <Field label={t("create.goalPlaceholder")} labelHidden style={s.input} value={goal} placeholder={t("create.goalPlaceholder")} onChangeText={setGoal} />
          <View style={s.row}>
            <Button s={s} label={t("create.propose")} disabled={!goal.trim() || start.isPending || shared.isPending || planning.data?.status === "running"} onPress={() => start.mutate()} />
            <Button s={s} secondary label={t("create.blank")} disabled={shared.isPending} onPress={() => beginDraft(fresh({ version: 1, goal, orchestrator: { workspace: "orchestrator", ...blankOrchestratorModel(catalog) }, roles: [newRole(catalog, [])] }))} />
          </View>
          <Errors s={s} errors={[...(planning.data?.status === "failed" ? planning.data.errors : []), ...(start.error ? [String(start.error)] : [])]} />
          {here !== null && data.projectTeams.length ? (
            <View style={[s.divider, { marginTop: 6, paddingTop: 12, gap: 6 }]}>
              <Text style={s.itemTitle}>{t("create.copyTitle")}</Text>
              <Text style={s.muted}>{t("create.copyHint")}</Text>
              <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, overflow: "hidden" }}>
                {data.projectTeams.map((entry, index) => (
                  <View key={entry.file} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: index > 0 ? 1 : 0, borderTopColor: theme.colors.border }}>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                        <Text style={[s.text, { flexShrink: 1, fontWeight: "600" }]}>{entry.workspace}</Text>
                        <Text style={s.muted}>{t("screen.roles", { count: entry.team.roles.length })}</Text>
                      </View>
                      {entry.goal ? <Text style={s.muted} numberOfLines={2}>{entry.goal}</Text> : null}
                    </View>
                    <View style={s.row}>
                      <Button s={s} compact secondary label={t("create.copy")} accessibilityLabel={t("create.copyNamed", { workspace: entry.workspace })} disabled={shared.isPending} onPress={() => beginDraft(fresh(copyTeamTo(entry.team, here)))} />
                      <Button s={s} compact secondary label={t("create.share")} accessibilityLabel={t("create.shareNamed", { workspace: entry.workspace })} disabled={shared.isPending || start.isPending || targetWorkspaceId === null} onPress={() => shared.mutate(entry.file)} />
                    </View>
                  </View>
                ))}
              </View>
              <Notice tone="status" announce={shared.isPending ? t("result.applying") : ""} style={s.row}>
                {shared.isPending ? <><ActivityIndicator color={theme.colors.accent} /><Text style={s.muted}>{t("result.applying")}</Text></> : null}
              </Notice>
              <Errors s={s} errors={[...(shared.error ? [String(shared.error)] : []), ...(shared.data && !shared.data.ok ? shared.data.errors : [])]} />
            </View>
          ) : null}
        </View>
      ) : (
        <SelectContext.Provider value={setPicker}>
          <View style={{ gap: 10 }}>
            <Text accessibilityRole="header" style={s.title}>{t("review.title")}</Text>
            <View style={s.orchestratorCard}>
              <Text style={s.orchestratorLabel}>{t("review.orchestrator")}</Text>
              {here === null && !(data.team && data.sharedWorkspaces.length) ? (
                <Field label={t("role.workspace")} labelHidden style={s.inputCompact} value={draft.orchestrator.workspace} placeholder={t("role.workspace")} onChangeText={(workspace) => setDraft((current) => (current ? { ...current, orchestrator: { ...current.orchestrator, workspace } } : current))} />
              ) : here === null ? (
                <Text style={s.muted}>{draft.orchestrator.workspace}</Text>
              ) : (
                <Text style={s.text}>{t("review.orchestratorHere", { workspace: here })}</Text>
              )}
              <ModelPicker s={s} catalog={catalog} provider={draft.orchestrator.provider} model={draft.orchestrator.model} onChange={(next) => setDraft((current) => (current ? { ...current, orchestrator: withModel(catalog, current.orchestrator, next) } : current))} extra={<EffortPicker s={s} catalog={catalog} provider={draft.orchestrator.provider} model={draft.orchestrator.model} effort={draft.orchestrator.effort} onChange={(effort) => setDraft((current) => (current ? { ...current, orchestrator: withEffort(current.orchestrator, effort) } : current))} />} />
            </View>
            <View style={s.roleGroupWrap}>
              <View style={s.roleConnector} />
              <View
                style={s.roleGroup}
                onLayout={(event) => {
                  const nextWidth = Math.round(event.nativeEvent.layout.width);
                  setRoleGroupWidth((current) => (current === nextWidth ? current : nextWidth));
                }}
              >
                {roleRows.map((row) => (
                  <View key={row[0]!.index} style={s.roleRow}>
                    {row.map(({ role, index }) => (
                      <RoleEditor key={index} s={s} role={role} catalog={catalog} onChange={(next) => updateRole(index, next)} onEditInstructions={() => setEditingRoleIndex(index)} onRemove={() => setDraft((current) => (current ? { ...current, roles: current.roles.filter((_, at) => at !== index) } : current))} />
                    ))}
                    {Array.from({ length: columns - row.length }, (_, spacer) => (
                      <View key={`spacer-${spacer}`} style={s.roleSpacer} />
                    ))}
                  </View>
                ))}
                <View style={s.row}>
                  <Button s={s} compact secondary icon={<Icon name="Plus" size={14} color={theme.colors.foreground} />} label={t("review.addRole")} onPress={() => setDraft((current) => (current ? { ...current, roles: [...current.roles, newRole(catalog, current.roles.map((role) => role.name))] } : current))} />
                </View>
                <View style={s.card}>
                  <Field label={t("review.teamEditRequest")} labelHidden style={[s.input, { minHeight: 56, textAlignVertical: "top" }]} value={editRequest} placeholder={t("review.teamEditRequest")} multiline onChangeText={setEditRequest} />
                  <View style={s.row}>
                    <Button s={s} compact secondary label={t("review.editTeamWithAi")} disabled={!editRequest.trim() || editBusy} onPress={() => startTeamEdit.mutate(draft)} />
                    <Button s={s} compact secondary label={t("review.undo")} disabled={!history.past.length || editBusy} onPress={() => { const result = undo(history, draft); if (result) { setHistory(result.history); setDraft(result.draft); setEditNotice(null); } }} />
                    <Button s={s} compact secondary label={t("review.redo")} disabled={!history.future.length || editBusy} onPress={() => { const result = redo(history, draft); if (result) { setHistory(result.history); setDraft(result.draft); setEditNotice(null); } }} />
                  </View>
                  <Errors s={s} errors={[...(editPlanning.data?.status === "failed" ? editPlanning.data.errors : []), ...(editPlanning.error ? [String(editPlanning.error)] : []), ...(editStartError ? [editStartError] : [])]} />
                  <Notice tone="status" announce={editNotice && editSummary ? t("review.editSummary") : ""} style={s.card}>
                    {editNotice && editSummary ? (
                    <>
                      <Text style={s.text}>{t("review.editSummary")}</Text>
                      {editSummary.added.map((name) => <Text key={`added-${name}`} style={s.text}>{t("review.editAdded", { name })}</Text>)}
                      {editSummary.removed.map((name) => <Text key={`removed-${name}`} style={s.text}>{t("review.editRemoved", { name })}</Text>)}
                      {editSummary.changed.map(({ name, fields }) => <Text key={`changed-${name}`} style={s.text}>{t("review.editChanged", { name, fields: fields.map((field) => t(field === "folders" ? "role.foldersName" : `role.${field}`)).join(", ") })}</Text>)}
                      {editSummary.orchestrator ? <Text style={s.text}>{t("review.editOrchestratorChanged")}</Text> : null}
                      {editSummary.orchestratorEffort ? <Text style={s.text}>{t("review.editOrchestratorEffortChanged")}</Text> : null}
                      {editSummary.goal ? <Text style={s.text}>{t("review.editGoalChanged")}</Text> : null}
                      {!editSummary.added.length && !editSummary.removed.length && !editSummary.changed.length && !editSummary.orchestrator && !editSummary.orchestratorEffort && !editSummary.goal ? <Text style={s.muted}>{t("review.editNoChanges")}</Text> : null}
                      {editNotice.validation.map((error) => <Text key={error.target + error.message} style={s.danger}>{error.target}: {error.message}</Text>)}
                    </>
                    ) : null}
                  </Notice>
                </View>
              </View>
            </View>
            <Notice tone="status" style={{ gap: 4 }}>
              {problems.map((problem) => <Text key={problem} style={s.danger}>{problem}</Text>)}
            </Notice>
            <View style={[s.row, s.divider, { paddingTop: 12 }]}>
              <Button s={s} label={t("review.apply")} disabled={problems.length > 0 || applied.isPending} onPress={() => applied.mutate(draft)} />
              <Button s={s} secondary label={t("review.cancel")} onPress={() => { if (plannerId) cancelled.mutate(); closeReview(); }} />
            </View>
          </View>
        </SelectContext.Provider>
      )}

      <Errors s={s} onShown={showMessages} token={outcomeToken(failures.filter((entry) => entry.errors.length).map((entry) => entry.from))} errors={failures.flatMap((entry) => entry.errors)} />
      <Notice
        tone="status"
        announce={restarted.isPending ? t("current.restarting") : result ? [t("result.applied", { file: result.file }), ...cleanupLines, ...notices].join(". ") : ""}
        token={outcomeToken([applied, shared])}
        onShown={showMessages}
        style={{ gap: 12 }}
      >
      {restarted.isPending ? <Text style={s.muted}>{t("current.restarting")}</Text> : null}
      {result ? (
        <View style={s.card}>
          <Text style={s.success}>{t("result.applied", { file: result.file })}</Text>
          {result.workspaces.map((workspace) => (
            <Text key={workspace.id} style={s.text}>• {t(workspace.created ? "result.created" : "result.reused", { target: workspace.target, workspace: workspace.workspace })}</Text>
          ))}
          {result.permission ? <Text style={s.muted}>{t("result.permission", { file: result.permission })}</Text> : null}
          {cleanupLines.map((line) => <Text key={line} style={s.danger}>{line}</Text>)}
          {notices.map((line) => <Text key={line} style={s.text}>{line}</Text>)}
          {navigation ? <Button s={s} label={t("result.openOrchestrator")} onPress={() => navigation.openAgent({ agentId: result.orchestratorAgentId })} /> : null}
        </View>
      ) : null}
      </Notice>
    </ScrollView>
  );
}
