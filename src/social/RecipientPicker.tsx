import { useEffect } from "react";
import { useConnections } from "../account/ConnectionsProvider";

interface Props {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label?: string;
}

/** Selecting someone grants only this post/plan access, never location access. */
export default function RecipientPicker({
  selected,
  onChange,
  disabled = false,
  label = "Who can see this?",
}: Props) {
  const { data, refreshing, error, refresh } = useConnections();
  const friends = data?.friends ?? [];
  const selectedCount = friends.filter((person) => selected.includes(person.id)).length;
  useEffect(() => {
    if (!data || error) return;
    const currentIds = new Set(data.friends.map((person) => person.id));
    const currentSelection = selected.filter((id) => currentIds.has(id));
    if (currentSelection.length !== selected.length) onChange(currentSelection);
  }, [data, error, selected, onChange]);
  return (
    <fieldset className="social-recipient-picker" disabled={disabled}>
      <legend>{label}</legend>
      <p className="social-muted">
        {selectedCount ? `${selectedCount} selected friend${selectedCount === 1 ? "" : "s"}` : "Only me"}.
        {" "}Choose specific friends. New friendships are never added automatically.
      </p>
      {error ? (
        <div className="social-inline-error" role="alert">
          <p>Your friends list is unavailable. Refresh it before selecting viewers.</p>
          <button type="button" className="button button-soft" onClick={() => void refresh()} disabled={refreshing}>
            Refresh friends
          </button>
        </div>
      ) : !data ? (
        <p role="status" className="social-muted">Loading your friends…</p>
      ) : friends.length ? (
        <div className="social-recipient-list">
          {friends.map((person) => (
            <label key={person.id} className="social-recipient-option">
              <input
                type="checkbox"
                checked={selected.includes(person.id)}
                disabled={disabled || refreshing}
                onChange={(event) => onChange(event.target.checked
                  ? [...selected.filter((id) => id !== person.id), person.id]
                  : selected.filter((id) => id !== person.id))}
              />
              <span>{person.display_name} <small>(@{person.username})</small></span>
            </label>
          ))}
        </div>
      ) : (
        <p className="social-muted">No friends to select yet. You can keep this private, or connect in Friends first.</p>
      )}
      <p className="social-sharing-note">Selected friends can see the names of people who interact. Removing or blocking a friend revokes their access. No GPS or location sharing is enabled.</p>
    </fieldset>
  );
}
