import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useAccount } from "../account/AccountProvider";
import { useConnections } from "../account/ConnectionsProvider";
import { fetchSocial, socialError } from "./api";
import type { SocialSnapshot } from "./types";

interface SocialContextValue {
  userId: string | null;
  data: SocialSnapshot | null;
  refreshing: boolean;
  error: string;
  setupRequired: boolean;
  busy: boolean;
  refresh: (afterMutation?: boolean) => Promise<void>;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

interface Snapshot {
  scope: string;
  data: SocialSnapshot | null;
  refreshing: boolean;
  error: string;
  setupRequired: boolean;
}

const SocialContext = createContext<SocialContextValue | null>(null);

export function SocialProvider({ children }: { children: ReactNode }) {
  const { session } = useAccount();
  const connections = useConnections();
  const userId = session?.user.id ?? null;
  // Relationship changes can revoke access. Hide the previous snapshot during
  // that render, rather than leaving a removed friend's posts visible on reload.
  const relationships = connections.data
    ? JSON.stringify([
        connections.data.friends.map((person) => person.id).sort(),
        connections.data.blocked.map((person) => person.id).sort(),
      ])
    : "unknown";
  const scope = `${userId ?? "anonymous"}:${relationships}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const activeOwner = useRef(userId);
  activeOwner.current = userId;
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const mutating = useRef<{ owner: string; token: symbol } | null>(null);
  const [busyOwner, setBusyOwner] = useState<string | null>(null);
  const lastRefreshFailed = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    scope,
    data: null,
    refreshing: Boolean(userId),
    error: "",
    setupRequired: false,
  });

  useLayoutEffect(() => {
    mutating.current = null;
    setBusyOwner(null);
    return () => { mutating.current = null; };
  }, [userId]);

  useLayoutEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    lastRefreshFailed.current = false;
    setSnapshot({
      scope,
      data: null,
      refreshing: Boolean(userId),
      error: "",
      setupRequired: false,
    });
    return () => {
      generation.current += 1;
      inFlight.current = null;
    };
  }, [scope, userId]);

  const refresh = useCallback(async (afterMutation = false): Promise<void> => {
    if (!userId || activeScope.current !== scope) return;
    const current = generation.current;
    if (inFlight.current) {
      if (!afterMutation) return inFlight.current;
      // A read begun before a write committed cannot verify its result.
      await inFlight.current;
      if (current !== generation.current || activeScope.current !== scope) return;
      if (inFlight.current) return inFlight.current;
    }
    setSnapshot((previous) => ({
      ...previous,
      scope,
      refreshing: true,
      error: "",
      setupRequired: false,
    }));
    const request = (async () => {
      try {
        const data = await fetchSocial();
        if (current !== generation.current || activeScope.current !== scope) return;
        lastRefreshFailed.current = false;
        setSnapshot((previous) => ({
          ...previous,
          scope,
          data,
          refreshing: false,
          error: "",
          setupRequired: false,
        }));
      } catch (cause) {
        if (current !== generation.current || activeScope.current !== scope) return;
        const readable = socialError(cause);
        lastRefreshFailed.current = true;
        setSnapshot((previous) => ({
          ...previous,
          data: null,
          refreshing: false,
          error: readable.message,
          setupRequired: readable.setupRequired,
        }));
      } finally {
        if (current === generation.current && activeScope.current === scope) {
          inFlight.current = null;
        }
      }
    })();
    inFlight.current = request;
    return request;
  }, [scope, userId]);

  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  const run = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    if (!userId || activeOwner.current !== userId) {
      throw new Error("Sign in to save changes to your plans and feed.");
    }
    if (mutating.current !== null) throw new Error("Please wait for your current change to finish.");
    const token = Symbol("social mutation");
    mutating.current = { owner: userId, token };
    const isCurrent = () => activeOwner.current === userId && mutating.current?.token === token;
    const requireCurrent = () => {
      if (!isCurrent()) throw new Error("Your account changed. Review your current account before making another change.");
    };
    setBusyOwner(userId);
    setSnapshot((previous) => ({ ...previous, error: "" }));
    try {
      await action();
      requireCurrent();
      // A relationship refresh can invalidate reads while a write is pending.
      // Its result still belongs to this account, so reload with the latest scope.
      await latestRefresh.current(true);
      requireCurrent();
      if (lastRefreshFailed.current) {
        setSnapshot((previous) => ({
          ...previous,
          error: "Your change was saved, but the latest plans and feed couldn’t load. Refresh to see the result.",
        }));
      }
    } catch (cause) {
      requireCurrent();
      const readable = socialError(cause);
      // Access may have been revoked since the last read; never keep displaying
      // a rejected item's private contents while a person retries the request.
      generation.current += 1;
      inFlight.current = null;
      setSnapshot((previous) => ({
        ...previous,
        data: null,
        refreshing: false,
        error: readable.message,
        setupRequired: readable.setupRequired,
      }));
      throw readable;
    } finally {
      if (isCurrent()) {
        mutating.current = null;
        setBusyOwner(null);
      }
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [userId, refresh]);

  const matches = snapshot.scope === scope;
  return (
    <SocialContext.Provider value={{
      userId,
      data: matches ? snapshot.data : null,
      refreshing: matches ? snapshot.refreshing : Boolean(userId),
      error: matches ? snapshot.error : "",
      setupRequired: matches ? snapshot.setupRequired : false,
      busy: userId !== null && busyOwner === userId,
      refresh,
      run,
    }}>
      {children}
    </SocialContext.Provider>
  );
}

export function useSocial() {
  const context = useContext(SocialContext);
  if (!context) throw new Error("useSocial requires SocialProvider.");
  return context;
}
