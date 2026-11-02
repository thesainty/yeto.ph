import { useEffect, useRef, useState } from "react";
import { useConnections } from "../account/ConnectionsProvider";
import { useAudienceCircles } from "./AudienceCirclesProvider";
import { MAX_CIRCLES, MAX_RECIPIENTS } from "./circles";
import type { AudienceCircle } from "./circles";
import CircleEditor from "./CircleEditor";
import "./recipient-picker.css";

interface Props {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label?: string;
}

function RecipientPickerContent({ selected, onChange, disabled = false, label = "Who can see this?" }: Props) {
  const { data, refreshing, error, refresh } = useConnections();
  const circles = useAudienceCircles();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ circle: AudienceCircle | null; members: string[] } | null>(null);
  const [deleting, setDeleting] = useState<AudienceCircle | null>(null);
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const friends = data?.friends ?? [];
  const selectedIds = new Set(selected);
  const selectedCount = selectedIds.size;
  const currentSelectedCount = friends.filter((person) => selectedIds.has(person.id)).length;
  const normalizedQuery = query.trim().toLocaleLowerCase().replace(/^@/, "");
  const shown = friends.filter((person) => !normalizedQuery ||
    person.display_name.toLocaleLowerCase().includes(normalizedQuery) ||
    person.username.toLocaleLowerCase().includes(normalizedQuery));
  const unavailable = disabled || refreshing || !!error || !data;
  const circleBusy = disabled || circles.busy || circles.refreshing;
  const currentIds = new Set(friends.map((person) => person.id));
  const currentMembers = (circle: AudienceCircle) => circle.member_ids.filter((id) => currentIds.has(id));

  useEffect(() => {
    if (!data || error) return;
    const ids = new Set(data.friends.map((person) => person.id));
    const currentSelection = [...new Set(selected)].filter((id) => ids.has(id));
    // Relationship changes can shrink a draft, but never add viewers to it.
    if (currentSelection.length !== selected.length) onChange(currentSelection);
  }, [data, error, selected, onChange]);

  function startEditing(circle: AudienceCircle | null) {
    setDeleting(null);
    setMessage("");
    setLocalError("");
    setEditing({ circle, members: circle ? currentMembers(circle) : selected.filter((id) => currentIds.has(id)) });
  }

  async function saveCircle(id: string | null, name: string, memberIds: string[]) {
    await circles.save(id, name, memberIds);
    if (!mounted.current) return;
    setEditing(null);
    setMessage("Circle saved. The recipients for this item are unchanged.");
  }

  async function deleteCircle() {
    if (!deleting || circleBusy) return;
    setLocalError("");
    try {
      await circles.remove(deleting.id);
      if (!mounted.current) return;
      setDeleting(null);
      setMessage("Circle deleted. Published audiences and this item’s recipients are unchanged.");
    } catch (cause) {
      if (mounted.current) setLocalError(cause instanceof Error ? cause.message : "We couldn’t delete this circle. Please try again.");
    }
  }

  return (
    <fieldset className="social-recipient-picker" disabled={disabled} onKeyDown={(event) => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
    }}>
      <legend>{label}</legend>
      <p className="social-muted recipient-summary" aria-live="polite">
        <strong>{selectedCount ? `${selectedCount} selected friend${selectedCount === 1 ? "" : "s"}` : "Only me"}</strong>.
        {" "}Choose up to {MAX_RECIPIENTS} current friends.
      </p>
      <div className="recipient-shortcuts" role="group" aria-label="Audience shortcuts">
        <button type="button" className="button button-soft" aria-pressed={selected.length === 0} disabled={disabled} onClick={() => onChange([])}>Only me</button>
        <button type="button" className="button button-soft" aria-pressed={friends.length > 0 && currentSelectedCount === friends.length && selectedCount === friends.length}
          disabled={unavailable || friends.length === 0 || friends.length > MAX_RECIPIENTS}
          onClick={() => onChange(friends.map((person) => person.id))}>All current friends</button>
      </div>
      {friends.length > MAX_RECIPIENTS && <p className="social-muted">You have more than {MAX_RECIPIENTS} friends. Select up to {MAX_RECIPIENTS} individually or use a smaller circle; no friends will be left out silently.</p>}
      <p className="social-sharing-note">Each choice selects people for this item only. New friends and later circle changes never add recipients to an older post or plan.</p>

      <section className="recipient-circles" aria-label="Saved circles">
        <div className="recipient-circles-heading">
          <strong>Your private circles</strong>
          <button type="button" className="button button-soft" disabled={circleBusy || unavailable || !circles.data || !!circles.error || circles.data.length >= MAX_CIRCLES} onClick={() => startEditing(null)}>Create circle</button>
        </div>
        <p className="social-muted">Saved to your account. Circle names and membership are visible only to you.</p>
        {circles.data && circles.data.length >= MAX_CIRCLES && <p className="social-muted">You’ve saved {MAX_CIRCLES} circles. Delete one before creating another.</p>}
        {circles.error ? (
          <div className="recipient-circle-status" role="status">
            <p>{circles.setupRequired ? "Saved circles aren’t available yet. You can still choose friends for this item." : circles.error}</p>
            <button type="button" className="button button-soft" disabled={circleBusy} onClick={() => void circles.refresh()}>Refresh circles</button>
          </div>
        ) : !circles.data ? (
          <p className="social-muted" role="status">Loading your circles…</p>
        ) : circles.data.length ? (
          <ul className="recipient-circle-list">
            {circles.data.map((circle) => {
              const members = currentMembers(circle);
              return (
                <li key={circle.id} className="recipient-circle-row">
                  <button type="button" className="button recipient-use-circle" aria-label={`Use ${circle.name}`} disabled={unavailable || circleBusy || members.length > MAX_RECIPIENTS} onClick={() => onChange([...members])}>
                    <span>{circle.name}</span><small>{members.length} friend{members.length === 1 ? "" : "s"}</small>
                  </button>
                  <button type="button" className="recipient-manage-circle" aria-label={`Edit ${circle.name}`} disabled={unavailable || circleBusy} onClick={() => startEditing(circle)}>Edit</button>
                  <button type="button" className="recipient-manage-circle" aria-label={`Delete ${circle.name}`} disabled={circleBusy} onClick={() => { setEditing(null); setDeleting(circle); setLocalError(""); setMessage(""); }}>Delete</button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="social-muted">Keep Pamilya, Barkada, or Close friends together in a circle you create.</p>
        )}
        {editing && <CircleEditor key={editing.circle?.id ?? "new-circle"} circle={editing.circle} initialMemberIds={editing.members} friends={friends}
          disabled={disabled || circles.busy || refreshing || !!error || !data} onSave={saveCircle} onCancel={() => setEditing(null)} />}
        {deleting && (
          <div className="recipient-circle-confirm" role="group" aria-label="Delete circle confirmation">
            <strong>Delete {deleting.name}?</strong>
            <p className="social-muted">This removes the saved circle. It doesn’t change published audiences or the recipients you’ve already selected.</p>
            <div className="recipient-shortcuts">
              <button type="button" className="button button-coral" disabled={circleBusy} onClick={() => void deleteCircle()}>Delete circle</button>
              <button type="button" className="button button-soft" disabled={circleBusy} onClick={() => setDeleting(null)}>Keep circle</button>
            </div>
          </div>
        )}
        {message && <p className="social-message" role="status">{message}</p>}
        {localError && <p className="social-inline-error" role="alert">{localError}</p>}
      </section>

      {error ? (
        <div className="social-inline-error" role="alert">
          <p>Your friends list is unavailable. Refresh it before selecting viewers.</p>
          <button type="button" className="button button-soft" onClick={() => void refresh()} disabled={refreshing}>Refresh friends</button>
        </div>
      ) : !data ? (
        <p role="status" className="social-muted">Loading your friends…</p>
      ) : friends.length ? (
        <>
          <label className="social-field recipient-search">Search friends
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or username" disabled={disabled} />
          </label>
          <p className="social-muted">{shown.length} of {friends.length} friends shown · {selectedCount} selected</p>
          <div className="social-recipient-list">
            {shown.map((person) => (
              <label key={person.id} className="social-recipient-option">
                <input type="checkbox" checked={selectedIds.has(person.id)} disabled={unavailable || (!selectedIds.has(person.id) && selectedCount >= MAX_RECIPIENTS)}
                  onChange={(event) => onChange(event.target.checked ? [...selected.filter((id) => id !== person.id), person.id] : selected.filter((id) => id !== person.id))} />
                <span>{person.display_name} <small>(@{person.username})</small></span>
              </label>
            ))}
            {!shown.length && <p className="social-muted">No friends match your search. Your selected friends stay selected.</p>}
          </div>
          {selectedCount >= MAX_RECIPIENTS && <p className="social-muted">You’ve selected the maximum of {MAX_RECIPIENTS} friends. Deselect someone to choose another friend.</p>}
        </>
      ) : (
        <p className="social-muted">No friends to select yet. You can keep this private, or connect in Friends first.</p>
      )}
      <p className="social-sharing-note">Selected friends can see the names of people who interact. Removing or blocking a friend revokes their access. No GPS or location sharing is enabled.</p>
    </fieldset>
  );
}

/** Only UUID snapshots leave this picker; circles never become live audiences. */
export default function RecipientPicker(props: Props) {
  const { userId } = useConnections();
  // A new owner gets a fresh search/editor immediately, before passive effects.
  return <RecipientPickerContent key={userId ?? "anonymous"} {...props} />;
}
