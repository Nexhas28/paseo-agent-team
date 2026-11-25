import { Children, forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, I18nManager, Platform, Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { announcementKey, rovingTabIndex, rovingTarget, tabStop } from "./logic";
import type { Colors, Styles } from "./styles";

type KeyEvent = { key: string; preventDefault?: () => void };

/** Key handling for web; native has no key events on views, where each item stays reachable on its own. */
export function onKeyDown(handler: (event: KeyEvent) => void): object {
  return Platform.OS === "web" ? { onKeyDown: handler } : {};
}

/** ARIA that React Native's types don't carry; only the web renders it. */
export function webAria(attrs: Record<string, string | boolean | number | undefined>): object {
  return Platform.OS === "web" ? attrs : {};
}

/** The OS reduce-motion setting, kept current. */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}

function focusRing(colors: Colors, focused: boolean): ViewStyle | null {
  return focused ? { outlineColor: colors.accent, outlineWidth: 2, outlineStyle: "solid", outlineOffset: 2 } : null;
}

/** Focus and a press this close together are one pointer gesture, whichever of the two is reported first. */
const PRESS_FOCUS_MS = 500;

/** Whether focus came from the keyboard, told from React Native press and focus events alone: a press beside the focus means the pointer. */
function useKeyboardFocus<Target>(): { focused: Target | null; onPressIn(): void; onFocus(target: Target): void; onBlur(target: Target): void } {
  const [focused, setFocused] = useState<Target | null>(null);
  const pressedAt = useRef(0);
  const focusedAt = useRef(0);
  return {
    focused,
    onPressIn: () => {
      pressedAt.current = Date.now();
      // The web focuses on pointer down, before the press is reported: take the ring back.
      if (Date.now() - focusedAt.current < PRESS_FOCUS_MS) setFocused(null);
    },
    onFocus: (target) => {
      focusedAt.current = Date.now();
      setFocused(Date.now() - pressedAt.current > PRESS_FOCUS_MS ? target : null);
    },
    onBlur: (target) => {
      focusedAt.current = 0;
      setFocused((current) => (current === target ? null : current));
    },
  };
}

/** A visible ring while the control has keyboard focus. Spread `handlers` on the Pressable and add `ring` to its style. */
export function useFocusRing(colors: Colors): { ring: ViewStyle | null; handlers: { onPressIn(): void; onFocus(): void; onBlur(): void } } {
  const focus = useKeyboardFocus<true>();
  return { ring: focusRing(colors, focus.focused === true), handlers: { onPressIn: focus.onPressIn, onFocus: () => focus.onFocus(true), onBlur: () => focus.onBlur(true) } };
}

/**
 * One button for every action. Primary (filled) for the one main action of a view, `secondary` (outlined) for the rest,
 * `danger` for the confirming step of something destructive; `compact` inside cards and rows.
 */
export function Button({ s, label, accessibilityLabel, onPress, disabled, secondary, danger, compact, icon }: { s: Styles; label: string; accessibilityLabel?: string; onPress(): void; disabled?: boolean; secondary?: boolean; danger?: boolean; compact?: boolean; icon?: ReactNode }) {
  const focus = useFocusRing(s.colors);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      aria-disabled={Boolean(disabled)}
      disabled={disabled}
      onPress={onPress}
      {...focus.handlers}
      style={({ pressed }) => [danger ? s.dangerButton : secondary ? s.secondary : s.button, compact ? s.buttonCompact : null, pressed ? { opacity: 0.8 } : null, disabled ? s.disabled : null, focus.ring]}
    >
      {icon}
      <Text style={[danger ? s.dangerButtonText : secondary ? s.secondaryText : s.buttonText, compact ? { fontSize: 12 } : null]}>{label}</Text>
    </Pressable>
  );
}

/** A text-only button, for quiet actions beside a row. */
export function LinkButton({ label, accessibilityLabel, color, colors, onPress, disabled, icon, bold, style }: { label: string; accessibilityLabel?: string; color: string; colors: Colors; onPress(): void; disabled?: boolean; icon?: ReactNode; bold?: boolean; style?: StyleProp<ViewStyle> }) {
  const focus = useFocusRing(colors);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} aria-disabled={Boolean(disabled)} disabled={disabled} hitSlop={8} onPress={onPress} {...focus.handlers} style={[{ flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 4, opacity: disabled ? 0.5 : 1 }, style, focus.ring]}>
      {icon}
      <Text style={{ color, fontSize: 12, fontWeight: bold ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

type Choice<Value extends string> = { value: Value; label: string; accessibilityLabel?: string };

/** One tab stop for a row of items on the web; arrows, Home and End move focus and call `onMove`, so selection follows focus. Native keeps a stop per item. */
function useRoving(count: number, selected: number, onMove: (index: number) => void) {
  const refs = useRef<(View | null)[]>([]);
  const focus = useKeyboardFocus<number>();
  const stop = tabStop(selected, count);
  const web = Platform.OS === "web";
  return {
    focused: focus.focused,
    item: (index: number) => ({
      ref: (element: View | null) => {
        refs.current[index] = element;
      },
      ...(web ? { tabIndex: rovingTabIndex(index, stop, web) } : {}),
      onPressIn: focus.onPressIn,
      onFocus: () => focus.onFocus(index),
      onBlur: () => focus.onBlur(index),
      ...onKeyDown((event) => {
        const next = rovingTarget(event.key, index, count, { rtl: I18nManager.isRTL });
        if (next === null) return;
        event.preventDefault?.();
        onMove(next);
        refs.current[next]?.focus();
      }),
    }),
  };
}

export function tabId(base: string, value: string): string {
  return `${base}-tab-${value}`;
}

/** A tab list (APG Tabs, automatic activation). Wrap each panel in `TabPanel` with the same `id`. */
export function Tabs<Value extends string>({ id, label, items, value, onChange, colors }: { id: string; label: string; items: readonly Choice<NoInfer<Value>>[]; value: Value; onChange: (value: NoInfer<Value>) => void; colors: Colors }) {
  const roving = useRoving(items.length, items.findIndex((item) => item.value === value), (index) => onChange(items[index]!.value));
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border }}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <Pressable
            key={item.value}
            id={tabId(id, item.value)}
            accessibilityRole="tab"
            accessibilityLabel={item.accessibilityLabel ?? item.label}
            aria-selected={selected}
            onPress={() => onChange(item.value)}
            {...roving.item(index)}
            style={[{ paddingHorizontal: 2, paddingVertical: 8, marginRight: 20, marginBottom: -1, borderBottomWidth: 2, borderBottomColor: selected ? colors.accent : "transparent", borderTopLeftRadius: 4, borderTopRightRadius: 4 }, focusRing(colors, roving.focused === index)]}
          >
            <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 13, fontWeight: selected ? "600" : "500" }}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function TabPanel({ id, value, children, style }: { id: string; value: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View role="tabpanel" aria-labelledby={tabId(id, value)} style={style}>{children}</View>;
}

/** A radio group (APG Radio Group): one tab stop, arrows pick the next option. `pill` is a row of chips, `segment` a compact joined control. */
export function RadioGroup<Value extends string>({ label, items, value, onChange, colors, variant }: { label: string; items: readonly Choice<NoInfer<Value>>[]; value: Value; onChange: (value: NoInfer<Value>) => void; colors: Colors; variant: "pill" | "segment" }) {
  const roving = useRoving(items.length, items.findIndex((item) => item.value === value), (index) => onChange(items[index]!.value));
  const pill = variant === "pill";
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={pill
        ? { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }
        : { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface1, borderRadius: 7, borderWidth: 1, borderColor: colors.border, padding: 2, gap: 2 }}
    >
      {items.map((item, index) => {
        const checked = item.value === value;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="radio"
            accessibilityLabel={item.accessibilityLabel ?? item.label}
            aria-checked={checked}
            onPress={() => onChange(item.value)}
            {...roving.item(index)}
            style={[
              pill
                ? { minHeight: 28, justifyContent: "center", paddingHorizontal: 12, borderRadius: 14, backgroundColor: checked ? colors.accent : colors.surface1, borderWidth: 1, borderColor: checked ? colors.accent : colors.border }
                : { minHeight: 22, justifyContent: "center", paddingHorizontal: 8, borderRadius: 5, backgroundColor: checked ? colors.accent : "transparent" },
              focusRing(colors, roving.focused === index),
            ]}
          >
            <Text style={{ color: checked ? colors.accentForeground : colors.foregroundMuted, fontSize: 12, fontWeight: checked ? "600" : "500" }}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Switch({ label, value, onChange, colors }: { label: string; value: boolean; onChange(value: boolean): void; colors: Colors }) {
  const focus = useFocusRing(colors);
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} aria-checked={value} onPress={() => onChange(!value)} {...focus.handlers} style={[{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, borderRadius: 6 }, focus.ring]}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "500" }}>{label}</Text>
      <View style={{ width: 32, height: 18, borderRadius: 9, backgroundColor: value ? colors.accent : colors.surface2, borderWidth: 1, borderColor: value ? colors.accent : colors.border, justifyContent: "center", paddingHorizontal: 1 }}>
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: value ? colors.accentForeground : colors.foregroundMuted, alignSelf: value ? "flex-end" : "flex-start" }} />
      </View>
    </Pressable>
  );
}

/** A text input that always has a name: the label is shown above it, or only spoken with `labelHidden` when a placeholder already shows it. */
export const Field = forwardRef<TextInput, Omit<TextInputProps, "style"> & { label: string; labelHidden?: boolean; labelStyle?: StyleProp<TextStyle>; style?: StyleProp<TextStyle>; containerStyle?: StyleProp<ViewStyle> }>(
  function Field({ label, labelHidden, labelStyle, containerStyle, ...input }, ref) {
    const field = <TextInput ref={ref} accessibilityLabel={label} {...input} />;
    if (labelHidden) return field;
    return (
      <View style={[{ gap: 4 }, containerStyle]}>
        <Text style={labelStyle}>{label}</Text>
        {field}
      </View>
    );
  },
);

/** A named group, so the controls of one role or team are told apart from the next one's. */
export function Group({ label, children, style }: { label: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View role="group" aria-label={label} style={style}>{children}</View>;
}

/** Takes an always-mounted view out of the layout while it has nothing to show, without hiding it from assistive technology. */
const COLLAPSED = { position: "absolute", width: 0, height: 0 } as const;

/**
 * A live region: what appears inside is announced. Keep it mounted and change its children.
 * `error` interrupts (alert), `status` waits its turn. iOS has no live regions, so `announce` is spoken there.
 * The same text is announced (and `onShown` called) again only when `token` changed: pass one that differs per outcome.
 * While empty it leaves the layout, so it adds no gap to its parent.
 */
export function Notice({ tone, announce, token, children, style, onShown }: { tone: "error" | "status"; announce?: string; token?: string | number; children?: ReactNode; style?: StyleProp<ViewStyle>; onShown?(): void }) {
  const shown = useRef("");
  useEffect(() => {
    const text = announce ?? "";
    const key = announcementKey(text, token);
    if (key === shown.current) return;
    shown.current = key;
    if (!text) return;
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(text);
    onShown?.();
  }, [announce, token]);
  return (
    <View
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      accessibilityLiveRegion={tone === "error" ? "assertive" : "polite"}
      style={Children.toArray(children).length ? style : COLLAPSED}
    >
      {children}
    </View>
  );
}

/**
 * A panel that opens in place with a message and controls (a confirmation, a suggestion to accept).
 * Only the message sits in the live region, which is mounted before it has text, so opening is announced once and the controls are not read as status.
 */
export function Prompt({ open, announce, message, children, style }: { open: boolean; announce: string; message: ReactNode; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={open ? style : COLLAPSED}>
      <Notice tone="status" announce={open ? announce : ""} style={{ gap: 6 }}>
        {open ? message : null}
      </Notice>
      {open ? children : null}
    </View>
  );
}

/** Error lines in an alert region; renders the region even when empty so later errors are announced. */
export function Errors({ s, errors, token, style, onShown }: { s: Styles; errors: readonly string[]; token?: string | number; style?: StyleProp<ViewStyle>; onShown?(): void }) {
  return (
    <Notice tone="error" announce={errors.join(". ")} token={token} onShown={onShown} style={[{ gap: 4 }, style]}>
      {errors.map((error, index) => <Text key={`${index}:${error}`} style={s.danger}>{error}</Text>)}
    </Notice>
  );
}
