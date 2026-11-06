import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAccount } from "../account/AccountProvider";
import { useConnections } from "../account/ConnectionsProvider";
import { useSocial } from "../social/SocialProvider";
import { conversationError, fetchConversations } from "./api";
import type { ConversationsSnapshot } from "./types";

interface Snapshot {
  scope: string;
  data: ConversationsSnapshot | null;
  refreshing: boolean;
  error: string;
  setupRequired: boolean;
}
interface ConversationsContextValue {
  userId: string | null;
  scope: string;
  data: ConversationsSnapshot | null;
  refreshing: boolean;
  error: string;
  setupRequired: boolean;
  busy: boolean;
  refresh: (afterMutation?: boolean) => Promise<void>;
  run: (action: () => Promise<unknown>) => Promise<void>;
}
const ConversationsContext = createContext<ConversationsContextValue | null>(null);

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const { session } = useAccount();
  const connections = useConnections();
  const social = useSocial();
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
    lastRefreshFailed.current = false;
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
        const data = await fetchConversations();
        if (current !== generation.current || activeScope.current !== scope) return;
        lastRefreshFailed.current = false;
        setSnapshot({ scope, data, refreshing: false, error: "", setupRequired: false });
      } catch (cause) {
        if (current !== generation.current || activeScope.current !== scope) return;
        lastRefreshFailed.current = true;
        const readable = conversationError(cause);
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
    if (!userId || activeOwner.current !== userId) throw new Error("Sign in to use your plan conversations.");
    if (mutation.current) throw new Error("Please wait for your current message change to finish.");
    const token = Symbol("conversation mutation");
    mutation.current = { owner: userId, token };
    const isCurrent = () => activeOwner.current === userId && mutation.current?.token === token;
    const requireCurrent = () => { if (!isCurrent()) throw new Error("Your account changed. Open your current account’s conversation."); };
    setBusyOwner(userId);
    setSnapshot((previous) => ({ ...previous, error: "" }));
    try {
      await action();
      requireCurrent();
      await latestRefresh.current(true);
      requireCurrent();
      if (lastRefreshFailed.current) setSnapshot((previous) => ({ ...previous, error: "Your message change was saved, but unread counts couldn’t load. Refresh to see the result." }));
    } catch (cause) {
      requireCurrent();
      generation.current += 1;
      inFlight.current = null;
      const readable = conversationError(cause);
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
    const interval = window.setInterval(visible, 15_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [userId, refresh]);
  useEffect(() => { if (social.data) void refresh(); }, [social.data, refresh]);
  const matches = snapshot.scope === scope;
  return <ConversationsContext.Provider value={{
    userId, scope, data: matches ? snapshot.data : null, refreshing: matches ? snapshot.refreshing : Boolean(userId),
    error: matches ? snapshot.error : "", setupRequired: matches ? snapshot.setupRequired : false,
    busy: userId !== null && busyOwner === userId, refresh, run,
  }}>{children}</ConversationsContext.Provider>;
}

export function useConversations() {
  const value = useContext(ConversationsContext);
  if (!value) throw new Error("useConversations requires ConversationsProvider.");
  return value;
}
