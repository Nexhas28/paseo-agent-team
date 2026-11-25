import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";

export type Colors = PluginWorkspacePanelProps["theme"]["colors"];

/**
 * One scale for the plugin's screens. Type: 20 screen heading, 16 view title, 14 item title, 13 body and controls, 12 secondary, 11 labels.
 * Controls: 32 high, 26 `compact`. Space: 4 inside a group, 8 between controls, 12 between cards, 14 inside a card.
 */
export function styles(colors: Colors, compact: boolean) {
  const control = { minHeight: 32, borderRadius: 6, paddingHorizontal: 12, flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 6 };
  const option = { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, minHeight: 36, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1 };
  return {
    colors,
    screen: { flex: 1, backgroundColor: colors.surface0 },
    body: { padding: compact ? 12 : 20, gap: 12 },
    heading: { color: colors.foreground, fontSize: 20, fontWeight: "700" as const },
    title: { color: colors.foreground, fontSize: 16, fontWeight: "600" as const },
    itemTitle: { color: colors.foreground, fontSize: 14, fontWeight: "600" as const },
    text: { color: colors.foreground, fontSize: 13, lineHeight: 18 },
    muted: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
    label: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const, letterSpacing: 0.3 },
    danger: { color: colors.statusDanger, fontSize: 12, lineHeight: 16 },
    warning: { color: colors.statusWarning, fontSize: 12, lineHeight: 16 },
    success: { color: colors.statusSuccess, fontSize: 13, fontWeight: "600" as const },
    card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: compact ? 12 : 14, gap: 8, backgroundColor: colors.surface1 },
    inset: { backgroundColor: colors.surface2, borderRadius: 6, padding: 10, gap: 8 },
    chip: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: colors.surface2, maxWidth: "100%" as const },
    divider: { borderTopWidth: 1, borderTopColor: colors.border },
    orchestratorCard: {
      borderTopWidth: 1,
      borderRightWidth: 1,
      borderBottomWidth: 1,
      borderLeftWidth: 4,
      borderTopColor: colors.border,
      borderRightColor: colors.border,
      borderBottomColor: colors.border,
      borderLeftColor: colors.accent,
      borderRadius: 8,
      padding: compact ? 12 : 14,
      gap: 8,
      backgroundColor: colors.surface2,
    },
    orchestratorLabel: { color: colors.accent, fontSize: 11, fontWeight: "700" as const, textTransform: "uppercase" as const, letterSpacing: 0.5 },
    roleGroupWrap: { flexDirection: "row" as const, paddingLeft: 2, gap: 16 },
    roleConnector: { width: 2, borderRadius: 1, backgroundColor: colors.accent, opacity: 0.4 },
    roleGroup: { flex: 1, minWidth: 0, gap: 12 },
    roleRow: { flexDirection: "row" as const, alignItems: "stretch" as const, gap: 12 },
    roleCard: { flex: 1, minWidth: 0 },
    roleSpacer: { flex: 1, minWidth: 0 },
    input: { minHeight: 32, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, color: colors.foreground, backgroundColor: colors.surface0 },
    inputCompact: { minHeight: 26, borderWidth: 1, borderColor: colors.border, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3, fontSize: 12, color: colors.foreground, backgroundColor: colors.surface0 },
    selectCompact: { minHeight: 26, flexDirection: "row" as const, alignItems: "center" as const, gap: 4, paddingHorizontal: 8, borderRadius: 5, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0 },
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
    button: { ...control, backgroundColor: colors.accent, borderWidth: 1, borderColor: colors.accent },
    buttonText: { color: colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    secondary: { ...control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 },
    secondaryText: { color: colors.foreground, fontSize: 13, fontWeight: "500" as const },
    dangerButton: { ...control, borderWidth: 1, borderColor: colors.statusDanger, backgroundColor: colors.surface1 },
    dangerButtonText: { color: colors.statusDanger, fontSize: 13, fontWeight: "600" as const },
    buttonCompact: { minHeight: 26, paddingHorizontal: 8, borderRadius: 5 },
    disabled: { opacity: 0.45 },
    select: { minHeight: 32, flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0 },
    option: { ...option, borderColor: "transparent", backgroundColor: "transparent" },
    optionActive: { ...option, borderColor: colors.border, backgroundColor: colors.surface2 },
    optionOn: { ...option, borderColor: colors.accent, backgroundColor: colors.accent },
    optionOnActive: { ...option, borderColor: colors.foreground, backgroundColor: colors.accent },
  };
}

export type Styles = ReturnType<typeof styles>;
