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
import { useAccount } from "./AccountProvider";
import { fetchConnections } from "./connections";
import type { Connections } from "./types";

interface ConnectionsContextValue {
  userId: string | null;
  data: Connections | null;
  refreshing: boolean;
  error: string;
  refresh: (afterMutation?: boolean) => Promise<void>;
}
interface Snapshot {
  owner: string | null;
  data: Connections | null;
  refreshing: boolean;
  error: string;
}

const ConnectionsContext = createContext<ConnectionsContextValue | null>(null);

export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const { session } = useAccount();
  const userId = session?.user.id ?? null;
  const [snapshot, setSnapshot] = useState<Snapshot>({
    owner: userId,
    data: null,
    refreshing: Boolean(userId),
    error: "",
  });
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const currentOwner = useRef(userId);
  currentOwner.current = userId;

  useLayoutEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    setSnapshot({ owner: userId, data: null, refreshing: Boolean(userId), error: "" });
    return () => {
      generation.current += 1;
      inFlight.current = null;
    };
  }, [userId]);

  const refresh = useCallback(async (afterMutation = false): Promise<void> => {
    if (!userId || currentOwner.current !== userId) return;
    const current = generation.current;
    if (inFlight.current) {
      if (!afterMutation) return inFlight.current;
      // A background read may have started before the RPC committed. Wait for
      // it before starting a read that is guaranteed to see the mutation.
      await inFlight.current;
      if (current !== generation.current || currentOwner.current !== userId) return;
      // Another post-mutation read may already have begun while we waited.
      if (inFlight.current) return inFlight.current;
    }
    setSnapshot((previous) => ({
      owner: userId,
      data: previous.owner === userId ? previous.data : null,
      refreshing: true,
      error: "",
    }));
    const request = (async () => {
      try {
        const next = await fetchConnections(userId);
        if (current !== generation.current) return;
        setSnapshot({ owner: userId, data: next, refreshing: false, error: "" });
      } catch (cause) {
        if (current !== generation.current) return;
        setSnapshot((previous) => ({
          ...previous,
          refreshing: false,
          error: cause instanceof Error
            ? cause.message
            : "We couldn’t load your connections. Please try refreshing.",
        }));
      } finally {
        if (current === generation.current) inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [userId, refresh]);

  // Hide a previous owner's snapshot during the identity-changing render itself,
  // before effects run. Keep App mounted so account dialogs retain their flow.
  const matchesOwner = snapshot.owner === userId;
  return (
    <ConnectionsContext.Provider value={{
      userId,
      data: matchesOwner ? snapshot.data : null,
      refreshing: matchesOwner ? snapshot.refreshing : Boolean(userId),
      error: matchesOwner ? snapshot.error : "",
      refresh,
    }}>
      {children}
    </ConnectionsContext.Provider>
  );
}

export function useConnections() {
  const context = useContext(ConnectionsContext);
  if (!context) throw new Error("useConnections requires ConnectionsProvider.");
  return context;
}
