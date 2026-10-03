"use client";

import { type KeyboardEvent, useRef } from "react";

const NEXT = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS = new Set(["ArrowLeft", "ArrowUp"]);

/** Where the arrow keys land from `at` among `count` choices, wrapping at both ends. */
export function stepChoice(at: number, count: number, key: string): number | null {
  if (NEXT.has(key)) {
    return (at + 1) % count;
  }
  if (PREVIOUS.has(key)) {
    return (at - 1 + count) % count;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return count - 1;
  }
  return null;
}

/**
 * A choice of one, the way a screen reader and a keyboard expect it: a
 * radiogroup whose chosen radio is the one tab stop, and the arrows move and
 * choose. The paths are drawn in reading order, so on a right-to-left page the
 * next one is still the one the right arrow reaches from the first.
 *
 * `locked` is a run under way: the keys do nothing, the same as a click on a
 * disabled radio.
 */
export function useRadioGroup<T extends string>(options: readonly T[], value: T, onChange: (next: T) => void, locked = false) {
  const items = useRef(new Map<T, HTMLElement>());

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (locked) {
      return;
    }
    const next = stepChoice(options.indexOf(value), options.length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const option = options[next];
    // A group with one choice left has nowhere to go, and asking for the same
    // choice again would clear whatever the form holds.
    if (option === value) {
      return;
    }
    onChange(option);
    items.current.get(option)?.focus();
  }

  function item(option: T) {
    const checked = option === value;
    return {
      role: "radio" as const,
      "aria-checked": checked,
      tabIndex: checked ? 0 : -1,
      ref: (node: HTMLElement | null) => {
        if (node === null) {
          items.current.delete(option);
        } else {
          items.current.set(option, node);
        }
      },
      onClick: () => onChange(option),
    };
  }

  return { group: { role: "radiogroup" as const, onKeyDown }, item };
}
