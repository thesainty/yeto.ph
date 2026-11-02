import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAccount } from "../account/AccountProvider";
import { useConnections } from "../account/ConnectionsProvider";
import { circleError, deleteAudienceCircle, fetchAudienceCircles, saveAudienceCircle } from "./circles";
import type { AudienceCircle } from "./circles";

interface CircleContextValue {
  userId: string | null;
  data: AudienceCircle[] | null;
  refreshing: boolean;
  busy: boolean;
  error: string;
  setupRequired: boolean;
  refresh: (afterMutation?: boolean) => Promise<void>;
  save: (id: string | null, name: string, memberIds: string[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
}
interface Snapshot {
  scope: string;
  data: AudienceCircle[] | null;
  refreshing: boolean;
  error: string;
  setupRequired: boolean;
}
const CircleContext = createContext<CircleContextValue | null>(null);

export function AudienceCirclesProvider({ children }: { children: ReactNode }) {
  const { session } = useAccount();
  const connections = useConnections();
  const userId = session?.user.id ?? null;
  const relationships = connections.data
    ? JSON.stringify([connections.data.friends.map((person) => person.id).sort(), connections.data.blocked.map((person) => person.id).sort()])
    : "unknown";
  const scope = `${userId ?? "anonymous"}:${relationships}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const activeOwner = useRef(userId);
  activeOwner.current = userId;
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const mutation = useRef<symbol | null>(null);
  const [busyOwner, setBusyOwner] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({ scope, data: null, refreshing: Boolean(userId), error: "", setupRequired: false });

  useLayoutEffect(() => {
    mutation.current = null;
    setBusyOwner(null);
    return () => { mutation.current = null; };
  }, [userId]);
  useLayoutEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    setSnapshot({ scope, data: null, refreshing: Boolean(userId), error: "", setupRequired: false });
    return () => { generation.current += 1; inFlight.current = null; };
  }, [scope, userId]);

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
        const data = await fetchAudienceCircles();
        if (current !== generation.current || activeScope.current !== scope) return;
        setSnapshot({ scope, data, refreshing: false, error: "", setupRequired: false });
      } catch (cause) {
        if (current !== generation.current || activeScope.current !== scope) return;
        const readable = circleError(cause);
        setSnapshot({ scope, data: null, refreshing: false, error: readable.message, setupRequired: readable.setupRequired });
      } finally {
        if (current === generation.current && activeScope.current === scope) inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [scope, userId]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  const run = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    if (!userId || activeOwner.current !== userId) throw new CircleErrorForAccount();
    if (mutation.current) throw new Error("Please wait for your circle change to finish.");
    const token = Symbol("circle change");
    mutation.current = token;
    const isCurrent = () => activeOwner.current === userId && mutation.current === token;
    const requireCurrent = () => { if (!isCurrent()) throw new CircleErrorForAccount(); };
    setBusyOwner(userId);
    try {
      await action();
      requireCurrent();
      await latestRefresh.current(true);
      requireCurrent();
      // The write succeeded even if its verification read failed. Keep the
      // provider's read error visible without encouraging a duplicate create.
    } catch (cause) {
      requireCurrent();
      throw circleError(cause);
    } finally {
      if (isCurrent()) { mutation.current = null; setBusyOwner(null); }
    }
  }, [userId]);
  const save = useCallback((id: string | null, name: string, memberIds: string[]) =>
    run(() => saveAudienceCircle(id, name, memberIds)), [run]);
  const remove = useCallback((id: string) => run(() => deleteAudienceCircle(id)), [run]);

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const whenVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = window.setInterval(whenVisible, 30_000);
    window.addEventListener("focus", whenVisible);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", whenVisible);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [userId, refresh]);

  const matches = snapshot.scope === scope;
  const currentIds = new Set(connections.data?.friends.map((person) => person.id));
  const data = matches && snapshot.data
    ? snapshot.data.map((circle) => ({ ...circle, member_ids: circle.member_ids.filter((id) => currentIds.has(id)) }))
    : null;
  return <CircleContext.Provider value={{
    userId, data, refreshing: matches ? snapshot.refreshing : Boolean(userId),
    busy: userId !== null && busyOwner === userId, error: matches ? snapshot.error : "",
    setupRequired: matches ? snapshot.setupRequired : false, refresh, save, remove,
  }}>{children}</CircleContext.Provider>;
}

class CircleErrorForAccount extends Error {
  constructor() { super("Your account changed. Review your current account before changing circles."); }
}

export function useAudienceCircles() {
  const value = useContext(CircleContext);
  if (!value) throw new Error("useAudienceCircles requires AudienceCirclesProvider.");
  return value;
}
