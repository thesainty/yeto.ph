import { useEffect, useId, useRef, useState } from "react";
import type { Profile } from "../account/types";
import { MAX_RECIPIENTS } from "./circles";
import type { AudienceCircle } from "./circles";

interface Props {
  circle: AudienceCircle | null;
  initialMemberIds: string[];
  friends: Profile[];
  disabled: boolean;
  onSave: (id: string | null, name: string, members: string[]) => Promise<void>;
  onCancel: () => void;
}

export default function CircleEditor({ circle, initialMemberIds, friends, disabled, onSave, onCancel }: Props) {
  const nameId = useId();
  const [name, setName] = useState(circle?.name ?? "");
  const [members, setMembers] = useState([...new Set(initialMemberIds)]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const ids = new Set(friends.map((person) => person.id));
    setMembers((previous) => previous.filter((id) => ids.has(id)));
  }, [friends]);
  const normalizedQuery = query.trim().toLocaleLowerCase().replace(/^@/, "");
  const shown = friends.filter((person) => !normalizedQuery ||
    person.display_name.toLocaleLowerCase().includes(normalizedQuery) ||
    person.username.toLocaleLowerCase().includes(normalizedQuery));
  const trimmedName = name.trim();
  const validName = trimmedName.length >= 1 && trimmedName.length <= 40 && !/[\u0000-\u001f\u007f]/.test(trimmedName);
  const busy = disabled || saving;

  async function save() {
    if (busy || !validName || members.length > MAX_RECIPIENTS) return;
    setSaving(true);
    setError("");
    try {
      await onSave(circle?.id ?? null, trimmedName, [...members]);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "We couldn’t save your circle. Please try again.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div className="recipient-circle-editor" role="group" aria-label={circle ? "Edit circle" : "Create circle"} onKeyDown={(event) => {
      // This editor lives inside the post or plan form. Enter must never publish.
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
    }}>
      <strong>{circle ? "Edit your circle" : "Create your circle"}</strong>
      <p className="social-muted">Only you can see this circle. Saving it won’t change this item’s recipients or any published audience.</p>
      <label className="social-field" htmlFor={nameId}>Circle name</label>
      <input className="recipient-circle-name" id={nameId} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} disabled={busy} placeholder="For example, Pamilya" />
      {!circle && <div className="recipient-name-suggestions" role="group" aria-label="Suggested circle names">
        {["Pamilya", "Barkada", "Close friends"].map((suggestion) => <button type="button" key={suggestion} disabled={busy} onClick={() => setName(suggestion)}>{suggestion}</button>)}
      </div>}
      <label className="social-field recipient-search">Search circle members
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or username" disabled={busy} />
      </label>
      <p className="social-muted" aria-live="polite">{members.length} of {MAX_RECIPIENTS} members selected · {shown.length} friends shown</p>
      <div className="social-recipient-list">
        {shown.map((person) => <label className="social-recipient-option" key={person.id}>
          <input type="checkbox" checked={members.includes(person.id)} disabled={busy || (!members.includes(person.id) && members.length >= MAX_RECIPIENTS)}
            onChange={(event) => setMembers((previous) => event.target.checked ? [...previous.filter((id) => id !== person.id), person.id] : previous.filter((id) => id !== person.id))} />
          <span>{person.display_name} <small>(@{person.username})</small></span>
        </label>)}
        {!shown.length && <p className="social-muted">{friends.length ? "No friends match your search." : "No current friends yet. You can save an empty circle and add friends later."}</p>}
      </div>
      {error && <p className="social-inline-error" role="alert">{error}</p>}
      <div className="recipient-shortcuts">
        <button type="button" className="button button-primary" disabled={busy || !validName || members.length > MAX_RECIPIENTS} onClick={() => void save()}>{saving ? "Saving circle…" : "Save circle"}</button>
        <button type="button" className="button button-soft" disabled={busy} onClick={onCancel}>Cancel circle changes</button>
      </div>
    </div>
  );
}
