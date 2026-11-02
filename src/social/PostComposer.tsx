import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, LockKeyhole, Send, Users } from "lucide-react";
import { Avatar, Modal } from "../components/ui";
import { useConnections } from "../account/ConnectionsProvider";
import { useIdentity } from "../account/useIdentity";
import { useSocial } from "./SocialProvider";
import { createPost } from "./api";
import { MAX_RECIPIENTS } from "./circles";
import RecipientPicker from "./RecipientPicker";
import AudienceReview from "./AudienceReview";

interface Props {
  onPublished: () => void;
}

/** Drafts remain in memory; only explicit recipient UUIDs are ever published. */
export default function PostComposer({ onPublished }: Props) {
  const { userId, data, busy, refreshing, error, run } = useSocial();
  const identity = useIdentity();
  const connections = useConnections();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"write" | "audience">("write");
  const [body, setBody] = useState("");
  const [viewers, setViewers] = useState<string[]>([]);
  const [formError, setFormError] = useState("");
  const alive = useRef(true);
  const owner = useRef(userId);
  owner.current = userId;
  const audienceButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const previousStep = useRef(step);
  const disabled = busy || refreshing || !data || !!error;
  const friendIds = new Set(connections.data?.friends.map((person) => person.id));
  const invalidSelection = viewers.length > MAX_RECIPIENTS || viewers.some((id) => !friendIds.has(id));
  const selectionUnavailable = viewers.length > 0 && (invalidSelection || connections.refreshing || !!connections.error || !connections.data);
  const audienceLabel = viewers.length ? `${viewers.length} friend${viewers.length === 1 ? "" : "s"}` : "Only me";
  const hasDraft = !!body.trim() || viewers.length > 0;

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setOpen(false);
    setStep("write");
    setBody("");
    setViewers([]);
    setFormError("");
  }, [userId]);

  useEffect(() => {
    if (!connections.data || connections.error) return;
    const currentIds = new Set(connections.data.friends.map((person) => person.id));
    // Circle edits/new friendships never alter a chosen audience. Relationship
    // removal may only shrink it, including while the audience step is closed.
    setViewers((previous) => {
      const current = [...new Set(previous)].filter((id) => currentIds.has(id));
      return current.length === previous.length ? previous : current;
    });
  }, [connections.data, connections.error]);

  useEffect(() => {
    if (previousStep.current !== step) {
      if (step === "audience") backButton.current?.focus();
      else audienceButton.current?.focus();
      previousStep.current = step;
    }
  }, [step]);

  function close() {
    if (busy) return;
    setOpen(false);
  }

  async function publish() {
    if (disabled || !body.trim()) return;
    setFormError("");
    if (viewers.length > MAX_RECIPIENTS) {
      setFormError(`Choose up to ${MAX_RECIPIENTS} friends for this update.`);
      return;
    }
    if (selectionUnavailable) {
      setFormError("Your selected friends have changed. Refresh your friends list and choose again.");
      return;
    }
    const actor = userId;
    const isCurrent = () => alive.current && owner.current === actor;
    const recipients = [...viewers];
    const text = body.trim();
    try {
      await run(() => createPost(text, recipients));
      if (!isCurrent()) return;
      setBody("");
      setViewers([]);
      setStep("write");
      setOpen(false);
      onPublished();
    } catch (cause) {
      if (isCurrent()) setFormError(cause instanceof Error ? cause.message : "We couldn’t save your update. Please try again.");
    }
  }

  return (
    <>
      <div className="card compact-composer">
        <Avatar id="mika" size={38} />
        <button type="button" className="compact-composer-prompt" disabled={disabled}
          aria-label={hasDraft ? "Continue update" : "Share an update"} onClick={() => { setStep("write"); setFormError(""); setOpen(true); }}>
          {hasDraft ? "Continue your update…" : "Share a little update…"}
        </button>
      </div>
      {open && (
        <div className="post-composer-layer" onKeyDownCapture={(event) => {
          if (event.key === "Escape" && step === "audience") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) setStep("write");
          }
        }}>
          <Modal title={step === "write" ? "Create update" : "Choose audience"} onClose={close}>
            <div className="post-composer">
              {step === "audience" ? (
                <div className="post-composer-audience">
                  <button ref={backButton} type="button" className="post-composer-back" onClick={() => setStep("write")} disabled={busy}>
                    <ArrowLeft size={17} /> Back to update
                  </button>
                  <RecipientPicker selected={viewers} onChange={setViewers} disabled={disabled} />
                  <button type="button" className="button button-primary post-composer-done" disabled={busy} onClick={() => setStep("write")}>Done choosing audience</button>
                </div>
              ) : (
                <form className="post-composer-form" aria-label="Post a check-in" onSubmit={(event) => { event.preventDefault(); void publish(); }}>
                  <div className="post-composer-person">
                    <Avatar id="mika" size={42} />
                    <div>
                      <strong>{identity.displayName}</strong>
                      <button ref={audienceButton} type="button" className="post-composer-audience-button" aria-label={`Audience: ${audienceLabel}`} disabled={disabled} onClick={() => setStep("audience")}>
                        {viewers.length ? <Users size={13} /> : <LockKeyhole size={13} />}
                        {audienceLabel}<ChevronDown size={13} />
                      </button>
                    </div>
                  </div>
                  <label className="social-field">
                    <span className="sr-only">Your update</span>
                    <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={240} rows={4} placeholder={`What’s new, ${identity.firstName}?`} required disabled={disabled} />
                  </label>
                  <AudienceReview selected={viewers} kind="post" />
                  {formError && <p className="social-inline-error" role="alert">{formError}</p>}
                  <div className="post-composer-footer">
                    <small className="social-muted">{body.length}/240</small>
                    <button className="button button-coral" type="submit" disabled={disabled || !body.trim() || selectionUnavailable}>
                      <Send size={15} /> {busy ? "Saving…" : "Publish update"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </Modal>
        </div>
      )}
    </>
  );
}
