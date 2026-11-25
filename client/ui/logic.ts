/** The item an arrow, Home or End key moves to in a one-tab-stop group (tabs, radios); wraps, skips disabled items, null when the key isn't ours. */
export function rovingTarget(
  key: string,
  index: number,
  count: number,
  { vertical = false, rtl = false, disabled = [] }: { vertical?: boolean; rtl?: boolean; disabled?: readonly boolean[] } = {},
): number | null {
  if (count <= 0) return null;
  const forward = vertical ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
  const backward = vertical ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
  const step = key === forward ? 1 : key === backward ? -1 : 0;
  const scan = (start: number, direction: 1 | -1) => {
    for (let moved = 0; moved < count; moved += 1) {
      const at = (((start + direction * moved) % count) + count) % count;
      if (!disabled[at]) return at;
    }
    return null;
  };
  if (step !== 0) return scan(index + step, step as 1 | -1);
  if (key === "Home") return scan(0, 1);
  if (key === "End") return scan(count - 1, -1);
  return null;
}

/** The one item of a group that takes Tab: the selected one, else the first that isn't disabled. */
export function tabStop(selected: number, count: number, disabled: readonly boolean[] = []): number {
  if (selected >= 0 && selected < count && !disabled[selected]) return selected;
  for (let at = 0; at < count; at += 1) if (!disabled[at]) return at;
  return -1;
}

/** The tabIndex of an item in a one-tab-stop group. Only the web has the arrow keys that reach the other items, so elsewhere every item keeps its own stop (undefined). */
export function rovingTabIndex(index: number, stop: number, web: boolean): 0 | -1 | undefined {
  if (!web) return undefined;
  return index === stop ? 0 : -1;
}

/** What a live region last announced: the same text counts as new again when the token (one per outcome) changed. Empty text is never announced. */
export function announcementKey(text: string, token: string | number | undefined): string {
  return text ? `${token ?? ""}\u0000${text}` : "";
}

/** Options whose text contains the query, ignoring case and outer spaces. */
export function matchOptions(options: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle ? options.filter((option) => option.toLowerCase().includes(needle)) : [...options];
}

/** The highlighted option after an arrow key in a listbox that does not wrap; null when the key isn't ours or nothing is listed. */
export function highlightTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const current = Math.max(0, Math.min(index, count - 1));
  if (key === "ArrowDown") return Math.min(count - 1, current + 1);
  if (key === "ArrowUp") return Math.max(0, current - 1);
  return null;
}

/** Where a list must scroll so the row is fully in view; null when it already is. */
export function scrollToReveal(row: { y: number; height: number }, top: number, viewHeight: number): number | null {
  if (row.y < top) return row.y;
  if (row.y + row.height > top + viewHeight) return row.y + row.height - viewHeight;
  return null;
}
