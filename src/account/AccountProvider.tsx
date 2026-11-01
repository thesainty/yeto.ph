import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { accountConfiguration, supabase } from "../lib/supabase";
import type { AccountConfiguration } from "../lib/supabase";
import { accountError } from "./errors";
import type { Profile } from "./types";

interface AccountContextValue {
  configuration: AccountConfiguration;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  profileError: string | null;
  recovery: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    name: string,
    email: string,
    password: string,
  ) => Promise<"signed-in" | "confirm-email">;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  updateProfile: (username: string, displayName: string) => Promise<void>;
  refreshProfile: () => Promise<void>;
}
const AccountContext = createContext<AccountContextValue | null>(null);
function client() {
  if (!supabase)
    throw new Error(
      "Connect the Supabase project using the setup guide first.",
    );
  return supabase;
}
function emailRedirect() {
  return `${window.location.origin}/`;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [profileError, setProfileError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const currentUser = useRef<string | null>(null);
  currentUser.current = session?.user.id ?? null;

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    // Do not await database calls inside the auth callback: the SDK holds an auth lock here.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setLoading(false);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") {
        setRecovery(false);
        setProfile(null);
        setProfileError(null);
      }
    });
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setProfileError(accountError(error).message);
        setSession(data.session);
        setLoading(false);
      })
      .catch((error) => {
        if (!active) return;
        setProfileError(accountError(error).message);
        setLoading(false);
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const refreshProfile = useCallback(async () => {
    const userId = session?.user.id;
    if (!userId) {
      setProfile(null);
      return;
    }
    const { data, error } = await client()
      .from("profiles")
      .select("id,username,display_name")
      .eq("id", userId)
      .single();
    if (currentUser.current !== userId) return;
    if (error) {
      const readable = accountError(error);
      setProfileError(readable.message);
      throw readable;
    }
    setProfile(data as Profile);
    setProfileError(null);
  }, [session?.user.id]);

  useEffect(() => {
    setProfile(null);
    setProfileError(null);
    if (session?.user.id)
      void refreshProfile().catch(() => {
        /* displayed in profileError */
      });
  }, [session?.user.id, refreshProfile]);

  async function signIn(email: string, password: string) {
    const { data, error } = await client().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw accountError(error);
    setSession(data.session);
    setRecovery(false);
  }
  async function signUp(
    name: string,
    email: string,
    password: string,
  ): Promise<"signed-in" | "confirm-email"> {
    if (!name.trim() || name.trim().length > 60 || password.length < 10)
      throw new Error(
        "Enter your name and a password with at least 10 characters.",
      );
    const { data, error } = await client().auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { display_name: name.trim() },
        emailRedirectTo: emailRedirect(),
      },
    });
    if (error) throw accountError(error);
    if (data.session) setSession(data.session);
    return data.session ? "signed-in" : "confirm-email";
  }
  async function signOut() {
    const { error } = await client().auth.signOut({ scope: "local" });
    if (error) throw accountError(error);
    setSession(null);
    setProfile(null);
    setProfileError(null);
    setRecovery(false);
  }
  async function sendPasswordReset(email: string) {
    const { error } = await client().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: emailRedirect(),
    });
    if (error) throw accountError(error);
  }
  async function updatePassword(password: string) {
    if (!recovery || !session)
      throw new Error("Open a fresh password recovery link first.");
    if (password.length < 10)
      throw new Error("Use a password with at least 10 characters.");
    const { error } = await client().auth.updateUser({ password });
    if (error) throw accountError(error);
    setRecovery(false);
  }
  async function updateProfile(username: string, displayName: string) {
    if (!session) throw new Error("Sign in before changing your profile.");
    const handle = username.trim().toLowerCase();
    if (
      !/^[a-z0-9_]{3,40}$/.test(handle) ||
      !displayName.trim() ||
      displayName.trim().length > 60
    )
      throw new Error(
        "Use a name up to 60 characters and a username with 3–40 letters, numbers, or underscores.",
      );
    const { error } = await client()
      .from("profiles")
      .update({ username: handle, display_name: displayName.trim() })
      .eq("id", session.user.id)
      .select("id")
      .single();
    if (error) throw accountError(error);
    await refreshProfile();
  }

  return (
    <AccountContext.Provider
      value={{
        configuration: accountConfiguration,
        session,
        profile: profile?.id === session?.user.id ? profile : null,
        loading,
        profileError,
        recovery,
        signIn,
        signUp,
        signOut,
        sendPasswordReset,
        updatePassword,
        updateProfile,
        refreshProfile,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}
export function useAccount() {
  const context = useContext(AccountContext);
  if (!context) throw new Error("AccountProvider is required");
  return context;
}
