import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Dispatch, SetStateAction } from "react";
import { initialState } from "./data";
import { loadStateWithStatus, STORAGE_KEY } from "./state";
import type { AppState } from "./types";

interface ScopedState {
  storageKey: string | null;
  state: AppState;
  storageUnavailable: boolean;
  storageReadFailed: boolean;
}

/**
 * Local demo activity belongs to the authenticated account that created it.
 * Anonymous activity keeps its original namespace and is never migrated into an
 * account. During auth restoration there is no active namespace or persistence.
 */
export function useDemoState(
  userId: string | null,
  authLoading: boolean,
): {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  storageUnavailable: boolean;
} {
  const storageKey = authLoading
    ? null
    : userId
      ? `${STORAGE_KEY}:${userId}`
      : STORAGE_KEY;
  const lastCommitted = useRef<ScopedState | null>(null);
  const departedNamespaces = useRef(new Set<string>());
  const snapshot = useMemo<ScopedState>(() => {
    const loaded =
      storageKey === null
        ? { state: structuredClone(initialState), storageUnavailable: false }
        : loadStateWithStatus(storageKey);
    // If storage failed during a previous logout, an abandoned demo session
    // still must not resume when that account returns within this app instance.
    if (storageKey !== null && departedNamespaces.current.has(storageKey)) {
      loaded.state = { ...loaded.state, sharing: null };
    }
    return {
      storageKey,
      ...loaded,
      storageReadFailed: loaded.storageUnavailable,
    };
  }, [storageKey]);
  const [scoped, setScoped] = useState(snapshot);
  const activeKey = useRef(storageKey);

  // Adjust this hook's own state before React commits the namespace change.
  // Returning the new snapshot also prevents even the first render for a new
  // account from containing the old account's activity.
  const current = scoped.storageKey === storageKey ? scoped : snapshot;
  if (scoped.storageKey !== storageKey) {
    setScoped(snapshot);
  }

  useLayoutEffect(() => {
    const previous = lastCommitted.current;
    activeKey.current = storageKey;
    if (
      previous &&
      previous.storageKey !== null &&
      previous.storageKey !== storageKey
    ) {
      // Mark every departure, even if sharing was already stopped in memory or
      // storage was unreadable. The saved record may still contain an older
      // session that a failed write prevented us from clearing.
      departedNamespaces.current.add(previous.storageKey);
      // End only the old namespace's session. Keep its posts, plans, and other
      // activity intact, and never replace a record whose initial read failed.
      if (!previous.storageReadFailed) {
        try {
          localStorage.setItem(
            previous.storageKey,
            JSON.stringify({ ...previous.state, sharing: null }),
          );
        } catch {
          // The new owner remains isolated; the in-memory marker above also
          // prevents revival if the previous owner signs back in this session.
        }
      }
    }
    lastCommitted.current = current;
  }, [storageKey, current]);

  const setState = useCallback<Dispatch<SetStateAction<AppState>>>(
    (action) => {
      if (storageKey === null || activeKey.current !== storageKey) return;
      setScoped((previous) => {
        // An async callback retained by a previous account cannot modify the
        // current namespace after login, logout, or an account switch.
        if (previous.storageKey !== storageKey) return previous;
        const next =
          typeof action === "function" ? action(previous.state) : action;
        return Object.is(next, previous.state)
          ? previous
          : { ...previous, state: next };
      });
    },
    [storageKey],
  );

  useEffect(() => {
    if (
      storageKey === null ||
      scoped.storageKey !== storageKey ||
      activeKey.current !== storageKey ||
      scoped.storageReadFailed
    ) {
      return;
    }
    // If the initial read failed, keep edits in memory for this namespace.
    // Writing fallback defaults could otherwise replace an existing record we
    // could not inspect. A reload or namespace change retries the read.
    let unavailable = false;
    try {
      localStorage.setItem(storageKey, JSON.stringify(scoped.state));
    } catch {
      unavailable = true;
    }
    setScoped((previous) =>
      previous.storageKey === storageKey &&
      previous.state === scoped.state &&
      previous.storageUnavailable !== unavailable
        ? { ...previous, storageUnavailable: unavailable }
        : previous,
    );
  }, [storageKey, scoped.storageKey, scoped.state, scoped.storageReadFailed]);

  return {
    state: current.state,
    setState,
    storageUnavailable: current.storageUnavailable,
  };
}
