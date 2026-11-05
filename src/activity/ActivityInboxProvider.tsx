import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAccount } from "../account/AccountProvider";
import { useConnections } from "../account/ConnectionsProvider";
import { useSocial } from "../social/SocialProvider";
import { usePolls } from "../polls/PollsProvider";
import { useReminders } from "../planning/RemindersProvider";
import { activityError, fetchActivity, markActivityRead } from "./api";
import type { ActivitySnapshot } from "./api";

interface ActivityContextValue {
  userId: string | null;
  data: ActivitySnapshot | null;
  refreshing: boolean;
  busy: boolean;
  error: string;
  setupRequired: boolean;
  refresh: (afterMutation?: boolean) => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
}
interface Snapshot { scope: string; data: ActivitySnapshot | null; refreshing: boolean; error: string; setupRequired: boolean }
const ActivityContext = createContext<ActivityContextValue | null>(null);

export function ActivityInboxProvider({ children }: { children: ReactNode }) {
  const { session } = useAccount();
  const connections = useConnections();
  const social = useSocial();
  const polls = usePolls();
  const reminders = useReminders();
  const userId = session?.user.id ?? null;
  const relationships = connections.data ? JSON.stringify([
    connections.data.friends.map((person) => person.id).sort(),
    connections.data.blocked.map((person) => person.id).sort(),
    connections.data.incoming.map((request) => request.id).sort(),
  ]) : "unknown";
  // Hide revoked activities in the relationship-changing render itself.
  const scope = `${userId ?? "anonymous"}:${relationships}:${connections.error ? "unavailable" : "ready"}`;
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
        const data = await fetchActivity();
        if (current !== generation.current || activeScope.current !== scope) return;
        setSnapshot({ scope, data, refreshing: false, error: "", setupRequired: false });
      } catch (cause) {
        if (current !== generation.current || activeScope.current !== scope) return;
        const readable = activityError(cause);
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
  const markRead = useCallback(async (ids: string[]): Promise<void> => {
    if (!userId || activeOwner.current !== userId) throw new Error("Sign in to read your activity.");
    if (mutation.current) throw new Error("Please wait for your current activity change to finish.");
    const token = Symbol("read activity");
    mutation.current = token;
    const isCurrent = () => activeOwner.current === userId && mutation.current === token;
    const requireCurrent = () => { if (!isCurrent()) throw new Error("Your account changed. Open your current account’s inbox."); };
    setBusyOwner(userId);
    try {
      await markActivityRead([...ids]);
      requireCurrent();
      await latestRefresh.current(true);
      requireCurrent();
    } catch (cause) {
      requireCurrent();
      throw activityError(cause);
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
  useEffect(() => { if (social.data || polls.data || reminders.data) void refresh(); }, [social.data, polls.data, reminders.data, refresh]);
  const matches = snapshot.scope === scope;
  return <ActivityContext.Provider value={{
    userId, data: matches ? snapshot.data : null, refreshing: matches ? snapshot.refreshing : Boolean(userId),
    busy: userId !== null && busyOwner === userId, error: matches ? snapshot.error : "", setupRequired: matches ? snapshot.setupRequired : false,
    refresh, markRead,
  }}>{children}</ActivityContext.Provider>;
}
export function useActivityInbox() {
  const value = useContext(ActivityContext);
  if (!value) throw new Error("useActivityInbox requires ActivityInboxProvider.");
  return value;
}
