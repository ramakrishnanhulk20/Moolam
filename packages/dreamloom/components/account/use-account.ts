"use client";

import { useEffect, useSyncExternalStore } from "react";
import { readAccountView, type AccountView } from "./account-api";

/**
 * This page's one read of /api/auth/session, shared by everything that needs the sign-in (the
 * header corner and the choose panel), so a page asks the server once, not once per part.
 *
 * Every Dreamloom link is a full page load, so the read lives as long as the page does. A sign-out
 * writes its answer here, and every part that reads the sign-in moves with it.
 */

export type AccountRead = { kind: "loading" } | { kind: "done"; view: AccountView | null };

export const LOADING: AccountRead = { kind: "loading" };

export interface AccountStore {
  get: () => AccountRead;
  subscribe: (listener: () => void) => () => void;
  /** Starts the read the first time it is asked, and does nothing after that. */
  start: () => void;
  set: (view: AccountView | null) => void;
}

export function createAccountStore(send: typeof fetch = (...args) => fetch(...args)): AccountStore {
  let current: AccountRead = LOADING;
  let started = false;
  const listeners = new Set<() => void>();

  function set(view: AccountView | null) {
    current = { kind: "done", view };
    for (const listener of listeners) listener();
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (started) return;
      started = true;
      void readAccountView(send).then((view) => {
        // A sign-out that answered first is newer than this read.
        if (current.kind === "loading") set(view);
      });
    },
    set,
  };
}

const pageStore = createAccountStore();

/** This page's sign-in: loading until the one session read answers, then the answer (null when the server did not answer). */
export function useAccount(store: AccountStore = pageStore): AccountRead {
  const read = useSyncExternalStore(store.subscribe, store.get, () => LOADING);
  useEffect(() => store.start(), [store]);
  return read;
}

/** Writes a newer answer (a sign-out's) for every part of the page that reads the sign-in. */
export function setAccount(view: AccountView | null, store: AccountStore = pageStore): void {
  store.set(view);
}
