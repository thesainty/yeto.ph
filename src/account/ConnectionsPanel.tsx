import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronRight,
  Clock3,
  Heart,
  RefreshCw,
  Search,
  ShieldCheck,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useAccount } from "./AccountProvider";
import { useConnections } from "./ConnectionsProvider";
import {
  blockPerson,
  cancelFriendRequest,
  removeConnection,
  respondFriendRequest,
  searchPeople,
  sendFriendRequest,
  unblockPerson,
} from "./connections";
import type { Profile } from "./types";
import "./connections.css";

type View = "friends" | "requests" | "blocked";
type Confirmation = { kind: "remove" | "block"; person: Profile };

function personLabel(person: Profile) {
  return person.display_name?.trim() || "TARA friend";
}

function Initials({ person }: { person: Profile }) {
  const letters = personLabel(person)
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  const color = (person.id.charCodeAt(0) || 0) % 3;
  return (
    <span
      className={`connections-avatar connections-avatar-${color}`}
      aria-hidden="true"
    >
      {letters}
    </span>
  );
}

function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "We couldn’t complete that request. Please try again.";
}

export default function ConnectionsPanel() {
  const { session } = useAccount();
  const userId = session?.user.id;
  const { data, refreshing, error: fetchError, refresh } = useConnections();
  const panelId = useId();
  const titleId = `${panelId}-title`;
  const searchId = `${panelId}-username`;
  const hintId = `${panelId}-hint`;
  const [view, setView] = useState<View>("friends");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Profile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setError] = useState("");
  const error = actionError || fetchError;
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const searchGeneration = useRef(0);

  function retryRefresh() {
    setError("");
    setMessage("");
    void refresh();
  }

  useEffect(() => {
    generation.current += 1;
    searchGeneration.current += 1;
    setResults(null);
    setQuery("");
    setView("friends");
    setError("");
    setMessage("");
    setConfirmation(null);
    setBusy(null);
    setSearching(false);
    return () => {
      generation.current += 1;
      searchGeneration.current += 1;
    };
  }, [userId]);

  useEffect(() => {
    if (!confirmation) return;
    confirmationTrigger.current = document.activeElement as HTMLElement | null;
    confirmationRef.current?.scrollIntoView({ block: "nearest" });
    confirmationRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
  }, [confirmation]);

  function cancelConfirmation() {
    setConfirmation(null);
    confirmationTrigger.current?.focus();
  }

  async function search() {
    const username = query.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{3,40}$/.test(username)) {
      setError("Use 3–40 letters, numbers, or underscores to find a username.");
      return;
    }
    const current = generation.current;
    const searchId = ++searchGeneration.current;
    setSearching(true);
    setResults(null);
    setError("");
    setMessage("");
    try {
      const matches = await searchPeople(username);
      if (
        current !== generation.current ||
        searchId !== searchGeneration.current
      )
        return;
      setResults(matches.filter((person) => person.id !== userId));
    } catch (cause) {
      if (
        current === generation.current &&
        searchId === searchGeneration.current
      ) {
        setError(errorText(cause));
      }
    } finally {
      if (
        current === generation.current &&
        searchId === searchGeneration.current
      ) {
        setSearching(false);
      }
    }
  }

  async function act(
    key: string,
    action: () => Promise<void>,
    success: string,
  ) {
    if (busy || refreshing || fetchError) return;
    const current = generation.current;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      await action();
      if (current !== generation.current) return;
      setConfirmation(null);
      setMessage(success);
      // A refreshed snapshot determines friendship/request status. No local demo fallback.
      await refresh(true);
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    } finally {
      if (current === generation.current) setBusy(null);
    }
  }

  if (!userId) return null;

  const disabled = !!busy || refreshing || !!fetchError;
  const requestsCount = data
    ? data.incoming.length + data.outgoing.length
    : null;
  const blockedIds = new Set(data?.blocked.map((person) => person.id));
  const visibleResults = results?.filter(
    (person) => !blockedIds.has(person.id),
  );

  return (
    <section className="connections-panel" aria-labelledby={titleId}>
      <div className="connections-heading">
        <div>
          <span className="connections-kicker">
            <Heart size={12} /> YOUR REAL-WORLD CIRCLE
          </span>
          <h3 id={titleId}>A little hello starts here.</h3>
        </div>
        <button
          type="button"
          className="icon-button connections-refresh"
          aria-label="Refresh your connections"
          title="Refresh connections"
          disabled={refreshing || !!busy}
          onClick={retryRefresh}
        >
          <RefreshCw
            size={17}
            className={refreshing ? "connections-spinning" : ""}
          />
        </button>
      </div>
      <p className="connections-intro">
        Find a friend by username, then send a request. Refresh to check for new
        activity. These real friends can be selected for Home updates and Plans.
        The map and journey tools remain demos.
      </p>

      <form
        className="connections-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label htmlFor={searchId}>Find someone by username</label>
        <div className="connections-search-row">
          <div className="connections-search-field">
            <Search size={17} aria-hidden="true" />
            <input
              id={searchId}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setResults(null);
                searchGeneration.current += 1;
                setSearching(false);
              }}
              placeholder="Your friend’s username"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={41}
              aria-describedby={hintId}
              disabled={!!busy}
            />
          </div>
          <button
            className="button button-primary"
            disabled={
              searching || !!busy || query.trim().replace(/^@/, "").length < 3
            }
          >
            {searching ? "Finding…" : "Find"}
          </button>
        </div>
        <span id={hintId}>
          Use at least 3 letters, numbers, or underscores.
        </span>
      </form>

      {error && (
        <div className="connections-error" role="alert">
          <ShieldCheck size={17} />
          <p>
            {error}
            {data && (
              <span> Your list may be out of date. Try refreshing.</span>
            )}
          </p>
        </div>
      )}
      {message && (
        <div className="connections-message" role="status">
          <Check size={16} />
          {message}
        </div>
      )}

      {visibleResults !== null && visibleResults !== undefined && (
        <div className="connections-search-results" aria-label="People found">
          <div className="connections-small-heading">
            <strong>People found</strong>
            <span>{visibleResults.length}</span>
          </div>
          {visibleResults.length === 0 ? (
            <p className="connections-no-results">
              No matches. Ask your friend for their exact username.
            </p>
          ) : (
            visibleResults.map((person) => {
              const isFriend = data?.friends.some(
                (friend) => friend.id === person.id,
              );
              const isRequested = data?.outgoing.some(
                (request) => request.recipient_id === person.id,
              );
              const isIncoming = data?.incoming.some(
                (request) => request.requester_id === person.id,
              );
              return (
                <div
                  className="connections-person connections-result"
                  key={person.id}
                >
                  <Initials person={person} />
                  <div className="connections-person-copy">
                    <strong>{personLabel(person)}</strong>
                    <small>@{person.username}</small>
                  </div>
                  <div className="connections-person-actions">
                    {isFriend ? (
                      <span className="connections-state">
                        <Check size={12} /> Friends
                      </span>
                    ) : isRequested ? (
                      <span className="connections-state">
                        <Clock3 size={12} /> Requested
                      </span>
                    ) : isIncoming ? (
                      <button
                        type="button"
                        className="button button-soft"
                        onClick={() => setView("requests")}
                      >
                        Respond <ChevronRight size={12} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button-coral"
                        disabled={disabled || !data}
                        onClick={() =>
                          void act(
                            `request-${person.id}`,
                            () => sendFriendRequest(person.id),
                            `Request sent to ${personLabel(person)}.`,
                          )
                        }
                        aria-label={`Send friend request to ${personLabel(person)}`}
                      >
                        <UserPlus size={13} /> Add friend
                      </button>
                    )}
                    <button
                      type="button"
                      className="connections-text-action"
                      disabled={disabled}
                      onClick={() => setConfirmation({ kind: "block", person })}
                      aria-label={`Block ${personLabel(person)}`}
                    >
                      Block
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      <div className="connections-tabs" aria-label="Connection lists">
        {(["friends", "requests", "blocked"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={view === item ? "connections-tab-selected" : ""}
            aria-pressed={view === item}
            onClick={() => {
              setView(item);
              setConfirmation(null);
            }}
          >
            {item === "friends"
              ? "Friends"
              : item === "requests"
                ? "Requests"
                : "Blocked"}
            {data && (
              <span>
                {item === "friends"
                  ? data.friends.length
                  : item === "requests"
                    ? requestsCount
                    : data.blocked.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {!data ? (
        <div className="connections-empty" role="status">
          <Users size={27} />
          <strong>
            {refreshing
              ? "Finding your people…"
              : "Your list isn’t available yet."}
          </strong>
          <p>
            {refreshing
              ? "Just a moment while your connections load."
              : "Check the project setup and refresh to try again."}
          </p>
          {!refreshing && (
            <button
              type="button"
              className="button button-soft"
              onClick={retryRefresh}
            >
              Try again
            </button>
          )}
        </div>
      ) : (
        <div className="connections-lists" aria-busy={refreshing}>
          {view === "friends" &&
            (data.friends.length ? (
              data.friends.map((person) => (
                <div className="connections-person" key={person.id}>
                  <Initials person={person} />
                  <div className="connections-person-copy">
                    <strong>{personLabel(person)}</strong>
                    <small>@{person.username}</small>
                  </div>
                  <div className="connections-person-actions">
                    <button
                      type="button"
                      className="connections-icon-action"
                      aria-label={`Remove ${personLabel(person)} as a friend`}
                      title="Remove friend"
                      disabled={disabled}
                      onClick={() =>
                        setConfirmation({ kind: "remove", person })
                      }
                    >
                      <UserMinus size={16} />
                    </button>
                    <button
                      type="button"
                      className="connections-icon-action"
                      aria-label={`Block ${personLabel(person)}`}
                      title="Block person"
                      disabled={disabled}
                      onClick={() => setConfirmation({ kind: "block", person })}
                    >
                      <Ban size={16} />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="connections-empty">
                <Users size={28} />
                <strong>Your circle starts with a hello.</strong>
                <p>
                  Ask someone you know for their username and send your first
                  request.
                </p>
              </div>
            ))}

          {view === "requests" && (
            <>
              <div className="connections-small-heading">
                <strong>Waiting for your hello</strong>
                <span>{data.incoming.length}</span>
              </div>
              {data.incoming.length ? (
                data.incoming.map((request) => (
                  <div
                    className="connections-person connections-request"
                    key={request.id}
                  >
                    <Initials person={request.person} />
                    <div className="connections-person-copy">
                      <strong>{personLabel(request.person)}</strong>
                      <small>@{request.person.username}</small>
                    </div>
                    <div className="connections-request-actions">
                      <button
                        type="button"
                        className="button button-coral"
                        disabled={disabled}
                        onClick={() =>
                          void act(
                            request.id,
                            () => respondFriendRequest(request.id, true),
                            `You and ${personLabel(request.person)} are now friends. Location sharing stays off.`,
                          )
                        }
                        aria-label={`Accept friend request from ${personLabel(request.person)}`}
                      >
                        <Check size={13} /> Accept
                      </button>
                      <button
                        type="button"
                        className="button button-soft"
                        disabled={disabled}
                        onClick={() =>
                          void act(
                            request.id,
                            () => respondFriendRequest(request.id, false),
                            "Friend request declined.",
                          )
                        }
                        aria-label={`Decline friend request from ${personLabel(request.person)}`}
                      >
                        <X size={13} /> Decline
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="connections-no-results">
                  No incoming requests right now.
                </p>
              )}
              <div className="connections-small-heading connections-outgoing-heading">
                <strong>Your hellos, on their way</strong>
                <span>{data.outgoing.length}</span>
              </div>
              {data.outgoing.length ? (
                data.outgoing.map((request) => (
                  <div className="connections-person" key={request.id}>
                    <Initials person={request.person} />
                    <div className="connections-person-copy">
                      <strong>{personLabel(request.person)}</strong>
                      <small>@{request.person.username}</small>
                    </div>
                    <button
                      type="button"
                      className="button button-soft"
                      disabled={disabled}
                      onClick={() =>
                        void act(
                          request.id,
                          () => cancelFriendRequest(request.id),
                          "Friend request cancelled.",
                        )
                      }
                      aria-label={`Cancel friend request to ${personLabel(request.person)}`}
                    >
                      Cancel
                    </button>
                  </div>
                ))
              ) : (
                <p className="connections-no-results">
                  You have no outgoing requests.
                </p>
              )}
            </>
          )}

          {view === "blocked" &&
            (data.blocked.length ? (
              data.blocked.map((person) => {
                const blockedPerson = {
                  ...person,
                  display_name: person.display_name || "Blocked member",
                  username: person.username || "",
                };
                return (
                  <div className="connections-person" key={person.id}>
                    <span
                      className="connections-blocked-avatar"
                      aria-hidden="true"
                    >
                      <Ban size={19} />
                    </span>
                    <div className="connections-person-copy">
                      <strong>{personLabel(blockedPerson)}</strong>
                      <small>
                        {person.username
                          ? `@${person.username}`
                          : `Member ${person.id.slice(0, 8)}`}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="button button-soft"
                      disabled={disabled}
                      onClick={() =>
                        void act(
                          person.id,
                          () => unblockPerson(person.id),
                          "Person unblocked. Friendship and sharing have not been restored.",
                        )
                      }
                      aria-label={`Unblock ${personLabel(blockedPerson)}`}
                    >
                      Unblock
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="connections-empty">
                <ShieldCheck size={28} />
                <strong>Your space, your choice.</strong>
                <p>
                  People you block will appear here. Unblocking never restores
                  friendship or sharing.
                </p>
              </div>
            ))}
        </div>
      )}

      {confirmation && (
        <div
          ref={confirmationRef}
          className="connections-confirm"
          role="group"
          aria-label={`${confirmation.kind === "block" ? "Block" : "Remove"} ${personLabel(confirmation.person)}?`}
        >
          <span className="connections-confirm-symbol">
            {confirmation.kind === "block" ? (
              <Ban size={20} />
            ) : (
              <UserMinus size={20} />
            )}
          </span>
          <div>
            <strong>
              {confirmation.kind === "block"
                ? `Block ${personLabel(confirmation.person)}?`
                : `Remove ${personLabel(confirmation.person)} as a friend?`}
            </strong>
            <p>
              {confirmation.kind === "block"
                ? "This removes your friendship and pending requests. You can unblock them later, but it won’t restore the friendship."
                : "You’ll need a new accepted request to be friends again."}
            </p>
          </div>
          <div className="connections-confirm-actions">
            <button
              type="button"
              className="button button-coral"
              disabled={disabled}
              onClick={() => {
                const target = confirmation.person;
                const blocking = confirmation.kind === "block";
                void act(
                  target.id,
                  async () => {
                    const current = generation.current;
                    if (blocking) await blockPerson(target.id);
                    else await removeConnection(target.id);
                    if (blocking && current === generation.current)
                      setResults(
                        (previous) =>
                          previous?.filter(
                            (person) => person.id !== target.id,
                          ) ?? null,
                      );
                  },
                  blocking
                    ? "Person blocked. Your friendship and pending requests have been removed."
                    : "Friend removed.",
                );
              }}
            >
              {busy
                ? "Please wait…"
                : confirmation.kind === "block"
                  ? "Yes, block"
                  : "Yes, remove"}
            </button>
            <button
              type="button"
              className="button button-soft"
              disabled={!!busy}
              onClick={cancelConfirmation}
            >
              Keep as is
            </button>
          </div>
        </div>
      )}

      <div className="connections-privacy">
        <ShieldCheck size={18} />
        <p>
          <strong>
            A friendship is a connection, not location permission.
          </strong>{" "}
          Adding or accepting a friend never enables GPS sharing.
        </p>
        <ArrowUpRight size={15} aria-hidden="true" />
      </div>
    </section>
  );
}
