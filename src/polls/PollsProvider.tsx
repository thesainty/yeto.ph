import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAccount } from "../account/AccountProvider";
import { useConnections } from "../account/ConnectionsProvider";
import { fetchPolls, fetchPollTarget, pollError } from "./api";
import type { PollSnapshot } from "./types";

interface PollTarget {
  scope: string;
  pollId: string;
  revision: number;
  data: PollSnapshot | null;
  loading: boolean;
  error: string;
}
interface Snapshot {
  scope: string;
  data: PollSnapshot | null;
  refreshing: boolean;
  error: string;
  setupRequired: boolean;
}
interface PollsContextValue {
  userId: string | null;
  data: PollSnapshot | null;
  refreshing: boolean;
  error: string;
  setupRequired: boolean;
  busy: boolean;
  refresh: (afterMutation?: boolean) => Promise<void>;
  run: (action: () => Promise<unknown>) => Promise<void>;
  activityTarget: PollTarget | null;
  openActivityTarget: (id: string) => Promise<void>;
  clearActivityTarget: () => void;
}
const PollsContext = createContext<PollsContextValue | null>(null);

export function PollsProvider({ children }: { children: ReactNode }) {
  const { session } = useAccount();
  const connections = useConnections();
  const userId = session?.user.id ?? null;
  const relationships = connections.data ? JSON.stringify([
    connections.data.friends.map((person) => person.id).sort(),
    connections.data.blocked.map((person) => person.id).sort(),
  ]) : "unknown";
  const scope = `${userId ?? "anonymous"}:${relationships}:${connections.error ? "unavailable" : "ready"}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const activeOwner = useRef(userId);
  activeOwner.current = userId;
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const mutation = useRef<{ owner: string; token: symbol } | null>(null);
  const lastRefreshFailed = useRef(false);
  const requestedTarget = useRef<{ pollId: string; token: symbol; revision: number } | null>(null);
  const targetRevision = useRef(0);
  const unavailable = useRef(new Set<string>());
  const [busyOwner, setBusyOwner] = useState<string | null>(null);
  const [target, setTarget] = useState<PollTarget | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({ scope, data: null, refreshing: Boolean(userId), error: "", setupRequired: false });

  useLayoutEffect(() => {
    mutation.current = null;
    setBusyOwner(null);
    return () => { mutation.current = null; };
  }, [userId]);
  useLayoutEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    requestedTarget.current = null;
    unavailable.current = new Set();
    lastRefreshFailed.current = false;
    setTarget(null);
    setSnapshot({ scope, data: null, refreshing: Boolean(userId), error: "", setupRequired: false });
    return () => { generation.current += 1; inFlight.current = null; };
  }, [scope, userId]);

  const openActivityTarget = useCallback(async (pollId: string, revalidate = false): Promise<void> => {
    if (!userId || activeScope.current !== scope) return;
    const token = Symbol("poll target");
    const revision = revalidate && requestedTarget.current ? requestedTarget.current.revision : ++targetRevision.current;
    requestedTarget.current = { pollId, token, revision };
    const current = generation.current;
    const matches = () => current === generation.current && activeScope.current === scope && requestedTarget.current?.token === token;
    setTarget({ scope, pollId, revision, data: null, loading: true, error: "" });
    try {
      const data = await fetchPollTarget(pollId);
      if (!matches()) return;
      const available = data.polls.some((poll) => poll.id === pollId);
      if (available) unavailable.current.delete(pollId);
      else {
        unavailable.current.add(pollId);
        setSnapshot((previous) => previous.scope !== scope || !previous.data ? previous : {
          ...previous, data: { polls: previous.data.polls.filter((poll) => poll.id !== pollId) },
        });
      }
      setTarget({ scope, pollId, revision, data: available ? { polls: data.polls.filter((poll) => poll.id === pollId) } : null, loading: false,
        error: available ? "" : "This poll is no longer available. It may have been deleted or your access may have changed." });
    } catch (cause) {
      if (matches()) setTarget({ scope, pollId, revision, data: null, loading: false, error: pollError(cause).message });
    }
  }, [scope, userId]);
  const clearActivityTarget = useCallback(() => { requestedTarget.current = null; setTarget(null); }, []);

  const refresh = useCallback(async (afterMutation = false): Promise<void> => {
    if (!userId || activeScope.current !== scope) return;
    const current = generation.current;
    if (inFlight.current) {
      if (!afterMutation) return inFlight.current;
      await inFlight.current;
      if (current !== generation.current || activeScope.current !== scope) return;
      if (inFlight.current) return inFlight.current;
    }
    setSnapshot((previous) => ({ ...previous, scope, refreshing: true, error: "", setupRequired: false }));
    const request = (async () => {
      try {
        const fetched = await fetchPolls();
        if (current !== generation.current || activeScope.current !== scope) return;
        const requested = requestedTarget.current;
        if (requested) await openActivityTarget(requested.pollId, true);
        if (current !== generation.current || activeScope.current !== scope) return;
        lastRefreshFailed.current = false;
        setSnapshot({ scope, data: { polls: fetched.polls.filter((poll) => !unavailable.current.has(poll.id)) }, refreshing: false, error: "", setupRequired: false });
      } catch (cause) {
        if (current !== generation.current || activeScope.current !== scope) return;
        lastRefreshFailed.current = true;
        const readable = pollError(cause);
        // A failed read cannot validate an older, separately opened poll. Hide
        // its contents too and invalidate an exact read still in flight. Keep
        // its ID so the user can explicitly retry with fresh authorization.
        if (requestedTarget.current) requestedTarget.current = {
          ...requestedTarget.current, token: Symbol("invalidated poll target"),
        };
        setTarget((previous) => previous?.scope === scope ? {
          ...previous, data: null, loading: false, error: readable.message,
        } : previous);
        setSnapshot({ scope, data: null, refreshing: false, error: readable.message, setupRequired: readable.setupRequired });
      } finally {
        if (current === generation.current && activeScope.current === scope) inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [scope, userId, openActivityTarget]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  const run = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    if (!userId || activeOwner.current !== userId) throw new Error("Sign in to save an availability poll.");
    if (mutation.current) throw new Error("Please wait for your current poll change to finish.");
    const token = Symbol("poll mutation");
    mutation.current = { owner: userId, token };
    const isCurrent = () => activeOwner.current === userId && mutation.current?.token === token;
    const requireCurrent = () => { if (!isCurrent()) throw new Error("Your account changed. Review your current account before making another change."); };
    setBusyOwner(userId);
    setSnapshot((previous) => ({ ...previous, error: "" }));
    try {
      await action();
      requireCurrent();
      await latestRefresh.current(true);
      requireCurrent();
      if (lastRefreshFailed.current) setSnapshot((previous) => ({ ...previous, error: "Your change was saved, but the latest polls couldn’t load. Refresh to see the result." }));
    } catch (cause) {
      requireCurrent();
      generation.current += 1;
      inFlight.current = null;
      requestedTarget.current = null;
      setTarget(null);
      const readable = pollError(cause);
      setSnapshot((previous) => ({ ...previous, data: null, refreshing: false, error: readable.message, setupRequired: readable.setupRequired }));
      throw readable;
    } finally {
      if (isCurrent()) { mutation.current = null; setBusyOwner(null); }
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = window.setInterval(visible, 30_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [userId, refresh]);

  const matches = snapshot.scope === scope;
  const activityTarget = target?.scope === scope ? target : null;
  const base = matches ? snapshot.data : null;
  const data = useMemo(() => {
    if (!base) return activityTarget?.data ?? null;
    if (!activityTarget) return base;
    return { polls: [...(activityTarget.data?.polls ?? []), ...base.polls.filter((poll) => poll.id !== activityTarget.pollId)] };
  }, [base, activityTarget]);
  return <PollsContext.Provider value={{
    userId, data, refreshing: matches ? snapshot.refreshing : Boolean(userId),
    error: matches ? snapshot.error : "", setupRequired: matches ? snapshot.setupRequired : false,
    busy: userId !== null && busyOwner === userId, refresh, run, activityTarget, openActivityTarget, clearActivityTarget,
  }}>{children}</PollsContext.Provider>;
}

export function usePolls() {
  const context = useContext(PollsContext);
  if (!context) throw new Error("usePolls requires PollsProvider.");
  return context;
}
