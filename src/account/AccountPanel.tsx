import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  HeartHandshake,
  Info,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useAccount } from "./AccountProvider";
import { useIdentity } from "./useIdentity";
import { suggestFunUsername } from "./usernames";
import ConnectionsPanel from "./ConnectionsPanel";
import "./account.css";

type Mode = "signin" | "signup" | "forgot";

function SetupGuide({ invalid }: { invalid: boolean }) {
  return (
    <div className="account-setup">
      <div className="account-setup-art" aria-hidden="true">
        <HeartHandshake size={38} strokeWidth={1.6} />
        <Sparkles size={18} />
      </div>
      <span className="account-state-badge">
        <span /> Not connected yet
      </span>
      <h3>Your people start with a little hello.</h3>
      <p className="account-setup-intro">
        We’re getting real accounts ready. Your sample TARA experience still
        works while you connect the project.
      </p>
      {invalid && (
        <div className="account-feedback account-feedback-error" role="alert">
          <Info size={18} />
          <p>
            The account configuration needs a check. Use the Project URL and a
            publishable key, never a private or admin key.
          </p>
        </div>
      )}
      <ol className="account-setup-steps">
        <li>
          <span>1</span>
          <div>
            <strong>Create your Supabase account</strong>
            <p>Supabase securely handles sign-ins and saved data for TARA.</p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Connect your existing Supabase project</strong>
            <p>
              Keep the database password private. You won’t need to share it
              here.
            </p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Follow the connection guide</strong>
            <p>
              The project includes <code>docs/CONNECT-SUPABASE.md</code> with
              the database and connection steps.
            </p>
          </div>
        </li>
      </ol>
      <a
        className="button button-primary button-full account-dashboard-link"
        href="https://supabase.com/dashboard"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open Supabase <ExternalLink size={15} />
      </a>
      <div className="account-expo-note">
        <Sparkles size={17} />
        <p>
          One step at a time. Your Expo account can wait until we build the
          phone apps.
        </p>
      </div>
    </div>
  );
}

function Feedback({ error, message }: { error: string; message: string }) {
  if (error)
    return (
      <div className="account-feedback account-feedback-error" role="alert">
        <Info size={17} />
        <p>{error}</p>
      </div>
    );
  if (message)
    return (
      <div className="account-feedback account-feedback-success" role="status">
        <CheckCircle2 size={17} />
        <p>{message}</p>
      </div>
    );
  return null;
}

function PasswordField({
  label,
  id,
  value,
  onChange,
  autoComplete,
  minLength,
  help,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  help?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="form-field" htmlFor={id}>
      {label}
      <span className="account-password-input">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          maxLength={128}
          aria-describedby={help ? `${id}-hint` : undefined}
          required
        />
        <button
          type="button"
          className="icon-button"
          aria-label={
            visible
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
      {help && (
        <small id={`${id}-hint`} className="account-field-hint">
          {help}
        </small>
      )}
    </label>
  );
}

export default function AccountPanel() {
  const account = useAccount();
  const identity = useIdentity();
  const id = useId();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileName, setProfileName] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setProfileName(account.profile?.display_name ?? "");
    setUsername(account.profile?.username ?? "");
  }, [account.profile?.display_name, account.profile?.username]);

  async function run(action: () => Promise<void>, success?: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      if (success) setMessage(success);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "We couldn’t complete that request. Please try again.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function changeMode(next: Mode) {
    if (busyRef.current) return;
    setMode(next);
    setPassword("");
    setConfirmPassword("");
    setError("");
    setMessage("");
  }

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      if (mode === "forgot") {
        await account.sendPasswordReset(email.trim());
        setMessage(
          "If that email has a TARA account, a reset link will arrive shortly. Check your inbox and spam folder.",
        );
      } else if (mode === "signup") {
        const result = await account.signUp(
          name.trim(),
          email.trim(),
          password,
        );
        setPassword("");
        if (result === "confirm-email") {
          setMessage(
            "Check your email to confirm your account. After confirmation, come back here to sign in. You aren’t signed in yet.",
          );
          setMode("signin");
        } else {
          setMessage(
            "Your account is ready. Tara, make it yours with a username.",
          );
        }
      } else {
        await account.signIn(email.trim(), password);
        setPassword("");
        setMessage("Welcome back. Your account is connected.");
      }
    });
  }

  const pendingIcon: ReactNode = busy ? (
    <LoaderCircle className="account-spin" size={17} />
  ) : (
    <ArrowRight size={17} />
  );

  if (account.configuration !== "ready")
    return <SetupGuide invalid={account.configuration === "invalid"} />;

  if (account.loading)
    return (
      <div className="account-loading" role="status">
        <LoaderCircle className="account-spin" size={28} />
        <strong>A little moment…</strong>
        <p>Checking your account session.</p>
      </div>
    );

  if (account.session && account.recovery)
    return (
      <div className="account-panel">
        <div className="account-form-heading">
          <span className="account-heading-icon">
            <KeyRound size={21} />
          </span>
          <div>
            <h3>A fresh start.</h3>
            <p>Choose a new password for your TARA account.</p>
          </div>
        </div>
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (password !== confirmPassword) {
              setError(
                "Your passwords don’t match. Please check them and try again.",
              );
              return;
            }
            void run(async () => {
              await account.updatePassword(password);
              setPassword("");
              setConfirmPassword("");
            }, "Password updated. Your account is ready to use.");
          }}
          aria-busy={busy}
        >
          <fieldset className="account-fields" disabled={busy}>
            <PasswordField
              id={`${id}-new-password`}
              label="New password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              minLength={10}
              help="Use at least 10 characters. A longer, unique password works best."
            />
            <PasswordField
              id={`${id}-confirm-password`}
              label="Confirm new password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              minLength={10}
            />
            <Feedback error={error} message={message} />
            <button
              className="button button-primary button-full"
              type="submit"
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle className="account-spin" size={17} />
              ) : (
                <Check size={17} />
              )}{" "}
              {busy ? "Updating password…" : "Update password"}
            </button>
          </fieldset>
        </form>
        <p className="account-session-footnote">
          <LockKeyhole size={13} /> This changes the password for your signed-in
          account.
        </p>
      </div>
    );

  if (account.session)
    return (
      <div className="account-panel">
        <div className="account-identity">
          <span className="account-identity-avatar" aria-hidden="true">
            {identity.initials}
          </span>
          <div>
            <span className="account-connected">
              <span /> Account connected
            </span>
            <h3>{identity.displayName}</h3>
            <p>{account.session.user.email}</p>
          </div>
        </div>
        <Feedback error={error} message={message} />
        {account.profile ? (
          <form
            className="dialog-form account-profile-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  account.updateProfile(
                    username.trim().toLowerCase(),
                    profileName.trim(),
                  ),
                "Profile saved. Looking good!",
              );
            }}
            aria-busy={busy}
          >
            <fieldset className="account-fields" disabled={busy}>
              <label className="form-field" htmlFor={`${id}-profile-name`}>
                Display name
                <input
                  id={`${id}-profile-name`}
                  autoComplete="name"
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  maxLength={60}
                  pattern={".*\\S.*"}
                  title="Enter a name with at least one non-space character"
                  required
                />
              </label>
              <label className="form-field" htmlFor={`${id}-username`}>
                Username
                <span className="account-username-input">
                  <span aria-hidden="true">@</span>
                  <input
                    id={`${id}-username`}
                    value={username}
                    onChange={(event) =>
                      setUsername(event.target.value.toLowerCase())
                    }
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="username"
                    minLength={3}
                    maxLength={40}
                    pattern="[a-z0-9_]{3,40}"
                    title="Use 3–40 lowercase letters, numbers, or underscores"
                    aria-describedby={`${id}-username-hint`}
                    required
                  />
                </span>
                <small
                  className="account-field-hint"
                  id={`${id}-username-hint`}
                >
                  3–40 lowercase letters, numbers, or underscores. Friends can
                  find you by username.
                </small>
              </label>
              <button
                className="button button-soft"
                type="button"
                onClick={() => {
                  setUsername(suggestFunUsername(username));
                  setError("");
                  setMessage("Suggestion ready. Save profile to use it.");
                }}
                disabled={busy}
              >
                <Sparkles size={16} /> Suggest a fun username
              </button>
              <button
                className="button button-primary button-full"
                type="submit"
                disabled={busy}
              >
                {busy ? (
                  <LoaderCircle className="account-spin" size={16} />
                ) : (
                  <Check size={16} />
                )}{" "}
                {busy ? "Saving profile…" : "Save profile"}
              </button>
            </fieldset>
          </form>
        ) : account.profileError ? (
          <div className="account-profile-retry">
            <div
              className="account-feedback account-feedback-error"
              role="alert"
            >
              <Info size={17} />
              <p>
                {account.profileError ??
                  "We couldn’t load your profile yet. Check that the database setup is complete, then try again."}
              </p>
            </div>
            <button
              className="button button-soft"
              onClick={() =>
                void run(account.refreshProfile, "Profile refreshed.")
              }
              disabled={busy}
            >
              <RefreshCw
                size={15}
                className={busy ? "account-spin" : undefined}
              />{" "}
              Retry profile
            </button>
          </div>
        ) : (
          <div className="account-profile-loading" role="status">
            <LoaderCircle className="account-spin" size={20} />
            <span>Getting your profile ready…</span>
          </div>
        )}
        {account.profile && (
          <div className="account-connections-divider">
            <ConnectionsPanel />
          </div>
        )}
        <div className="account-real-note">
          <ShieldCheck size={18} />
          <p>
            Your profile, friendships, Home updates, and Plans use real data.
            The map and journey tools remain demos. GPS sharing is not enabled.
          </p>
        </div>
        <button
          className="button button-soft button-full account-sign-out"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await account.signOut();
              setPassword("");
              setConfirmPassword("");
              setMode("signin");
            }, "You’re signed out on this device.")
          }
        >
          <LogOut size={16} /> {busy ? "Please wait…" : "Sign out"}
        </button>
      </div>
    );

  return (
    <div className="account-panel">
      {mode !== "forgot" ? (
        <div className="account-tabs" aria-label="Account access">
          <button
            type="button"
            aria-pressed={mode === "signin"}
            className={mode === "signin" ? "account-tab-active" : ""}
            onClick={() => changeMode("signin")}
            disabled={busy}
          >
            Sign in
          </button>
          <button
            type="button"
            aria-pressed={mode === "signup"}
            className={mode === "signup" ? "account-tab-active" : ""}
            onClick={() => changeMode("signup")}
            disabled={busy}
          >
            Create account
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="account-back"
          onClick={() => changeMode("signin")}
          disabled={busy}
        >
          <ArrowLeft size={14} /> Back to sign in
        </button>
      )}
      <div className="account-form-heading">
        <span className="account-heading-icon">
          {mode === "signup" ? (
            <UserRound size={21} />
          ) : mode === "forgot" ? (
            <Mail size={21} />
          ) : (
            <HeartHandshake size={21} />
          )}
        </span>
        <div>
          <h3>
            {mode === "signup"
              ? "A little hello, a new beginning."
              : mode === "forgot"
                ? "Let’s get you back in."
                : "Your people are waiting."}
          </h3>
          <p>
            {mode === "signup"
              ? "Start your own little world in TARA."
              : mode === "forgot"
                ? "We’ll send a link to reset your password."
                : "Sign in to your own TARA account."}
          </p>
        </div>
      </div>
      <form
        className="dialog-form"
        onSubmit={(event) => void submitCredentials(event)}
        aria-busy={busy}
      >
        <fieldset className="account-fields" disabled={busy}>
          {mode === "signup" && (
            <label className="form-field" htmlFor={`${id}-name`}>
              Your name
              <input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                placeholder="What should your people call you?"
                maxLength={60}
                pattern={".*\\S.*"}
                title="Enter a name with at least one non-space character"
                required
              />
            </label>
          )}
          <label className="form-field" htmlFor={`${id}-email`}>
            Email address
            <input
              id={`${id}-email`}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              maxLength={254}
              required
            />
          </label>
          {mode !== "forgot" && (
            <PasswordField
              id={`${id}-password`}
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              minLength={mode === "signup" ? 10 : undefined}
              help={
                mode === "signup"
                  ? "At least 10 characters. Choose a password you don’t use anywhere else."
                  : undefined
              }
            />
          )}
          {mode === "signin" && (
            <button
              type="button"
              className="account-forgot"
              onClick={() => changeMode("forgot")}
            >
              Forgot password?
            </button>
          )}
          <Feedback
            error={error || account.profileError || ""}
            message={message}
          />
          <button
            className="button button-primary button-full"
            type="submit"
            disabled={busy}
          >
            {pendingIcon}
            {busy
              ? "A little moment…"
              : mode === "signup"
                ? "Create my TARA account"
                : mode === "forgot"
                  ? "Send reset link"
                  : "Sign in to TARA"}
          </button>
        </fieldset>
      </form>
      <div className="account-real-note">
        <ShieldCheck size={18} />
        <p>
          Sign in to use real friends, Home updates, and Plans. GPS sharing is not
          enabled.
        </p>
      </div>
    </div>
  );
}
