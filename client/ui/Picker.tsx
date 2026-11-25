import { useTranslation } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useId, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { messages } from "../i18n";
import { Notice, webAria } from "./controls";
import { highlightTarget, matchOptions, scrollToReveal } from "./logic";
import type { Styles } from "./styles";

export type SelectRequest = { label: string; options: readonly string[]; value: string; onChange(value: string): void };

/**
 * A searchable single-select list in a modal (APG Combobox with a listbox popup).
 * Focus stays in the search field; arrows move the highlight, exposed as the active descendant, and Enter picks it.
 */
export function PickerModal({ s, request, onClose }: { s: Styles; request: SelectRequest | null; onClose(): void }) {
  const { t } = useTranslation(messages);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<ScrollView>(null);
  const rowLayouts = useRef<Record<number, { y: number; height: number }>>({});
  const listHeight = useRef(0);
  const scrollY = useRef(0);
  const active = useRef<SelectRequest | null>(null);

  // A new request starts from an empty search, reset while rendering so its first frame never filters by the last picker's query.
  const [rendered, setRendered] = useState(request);
  if (rendered !== request) {
    setRendered(request);
    setQuery("");
    setHighlight(Math.max(0, request ? request.options.indexOf(request.value) : 0));
  }
  useEffect(() => {
    active.current = request;
    rowLayouts.current = {};
    scrollY.current = 0;
  }, [request]);

  const options = request ? matchOptions(request.options, query) : [];
  const highlighted = options.length > 0 ? Math.min(highlight, options.length - 1) : -1;
  const pick = (option: string) => {
    const current = active.current;
    if (!current) return;
    active.current = null;
    onClose();
    current.onChange(option);
  };
  const pickHighlighted = () => {
    if (highlighted >= 0) pick(options[highlighted]!);
  };

  useEffect(() => {
    if (!request || highlighted < 0) return;
    const row = rowLayouts.current[highlighted] ?? { y: highlighted * 40, height: 36 };
    const y = scrollToReveal(row, scrollY.current, listHeight.current || 320);
    if (y === null) return;
    scrollY.current = y;
    listRef.current?.scrollTo({ y, animated: false });
  }, [highlighted, request, query]);

  return (
    <Modal
      title={request?.label ?? ""}
      open={request !== null}
      onOpenChange={(open) => {
        if (open) return;
        active.current = null;
        onClose();
      }}
    >
      <Modal.Content>
        {request ? (
          <>
            <TextInput
              style={s.input}
              value={query}
              placeholder={t("role.searchPlaceholder")}
              accessibilityLabel={request.label}
              autoFocus
              {...webAria({
                role: "combobox",
                "aria-autocomplete": "list",
                "aria-expanded": true,
                "aria-controls": listId,
                "aria-activedescendant": highlighted >= 0 ? optionId(highlighted) : undefined,
              })}
              onChangeText={(text) => {
                rowLayouts.current = {};
                scrollY.current = 0;
                setQuery(text);
                setHighlight(0);
              }}
              onKeyPress={(event) => {
                const key = event.nativeEvent.key;
                if (key === "Enter") {
                  event.preventDefault?.();
                  pickHighlighted();
                  return;
                }
                const next = highlightTarget(key, highlight, options.length);
                if (key === "ArrowDown" || key === "ArrowUp") event.preventDefault?.();
                if (next !== null) setHighlight(next);
              }}
              onSubmitEditing={pickHighlighted}
            />
            <Notice tone="status" announce={options.length ? t("picker.resultCount", { count: options.length }) : t(request.options.length === 0 ? "role.noOptions" : "role.noMatches")}>
              <Text style={s.muted}>{options.length ? t("picker.resultCount", { count: options.length }) : t(request.options.length === 0 ? "role.noOptions" : "role.noMatches")}</Text>
            </Notice>
            <ScrollView
              ref={listRef}
              style={{ maxHeight: 320 }}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              scrollEventThrottle={16}
              onLayout={(event) => {
                listHeight.current = event.nativeEvent.layout.height;
              }}
              onScroll={(event) => {
                scrollY.current = event.nativeEvent.contentOffset.y;
              }}
            >
              <View id={listId} aria-label={request.label} {...webAria({ role: "listbox" })} style={{ gap: 4 }}>
                {options.map((option, index) => {
                  const selected = option === request.value;
                  const focused = index === highlighted;
                  return (
                    <Pressable
                      key={option}
                      id={optionId(index)}
                      aria-label={option}
                      aria-selected={selected}
                      {...(Platform.OS === "web" ? { role: "option" as const, tabIndex: -1 as const } : { role: "button" as const })}
                      onLayout={(event) => {
                        const { y, height } = event.nativeEvent.layout;
                        rowLayouts.current[index] = { y, height };
                      }}
                      onPress={() => pick(option)}
                      style={selected ? (focused ? s.optionOnActive : s.optionOn) : focused ? s.optionActive : s.option}
                    >
                      <Text style={selected ? s.buttonText : s.text}>{option}</Text>
                      {selected ? <Text aria-hidden style={s.buttonText}>✓</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
