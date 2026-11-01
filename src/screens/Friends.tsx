import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Heart,
  LockKeyhole,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Sparkles,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Avatar, AvatarStack } from "../components/ui";
import { useIdentity } from "../account/useIdentity";
import { people } from "../data";
import type { PersonId } from "../types";
import "./friends.css";

interface FriendsProps {
  friendIds: PersonId[];
  requestStatus: "pending" | "accepted" | "declined";
  onAccept: () => void;
  onDecline: () => void;
  onAddFriend: () => void;
  onRemoveFriend: (id: PersonId) => void;
  onShare: () => void;
}

export default function Friends({
  friendIds,
  requestStatus,
  onAccept,
  onDecline,
  onAddFriend,
  onRemoveFriend,
  onShare,
}: FriendsProps) {
  const identity = useIdentity();
  const [view, setView] = useState<"friends" | "circles">("friends");
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<PersonId | null>(null);
  const [openCircle, setOpenCircle] = useState<"Pamilya" | "Barkada" | null>(
    null,
  );
  const filteredFriends = friendIds.filter((id) =>
    `${people[id].fullName} ${people[id].handle}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const familyMembers: PersonId[] = [
    "mika",
    ...friendIds.filter((id) => id === "paolo" || id === "ana"),
  ];
  const barkadaMembers: PersonId[] = ["mika", ...friendIds];
  const circleMembers =
    openCircle === "Pamilya" ? familyMembers : barkadaMembers;

  const circles = (
    <section className="friends-circles-section" aria-label="Your circles">
      <div className="friends-section-title">
        <h2>Your circles</h2>
        <span className="muted">A place for your people</span>
      </div>
      <div className="friends-circle-grid">
        <button
          type="button"
          className={`friends-circle friends-circle-family ${openCircle === "Pamilya" ? "friends-circle-selected" : ""}`}
          onClick={() =>
            setOpenCircle(openCircle === "Pamilya" ? null : "Pamilya")
          }
          aria-expanded={openCircle === "Pamilya"}
          aria-controls="friends-circle-detail"
        >
          <span className="friends-circle-top">
            <span className="friends-circle-icon">
              <Heart size={21} fill="currentColor" />
            </span>
            <ArrowUpRight size={20} />
          </span>
          <strong>Pamilya</strong>
          <span>{familyMembers.length} people · sample circle</span>
          <div className="friends-circle-bottom">
            <AvatarStack ids={familyMembers} size={29} />
            <span className="friends-circle-arrow">
              <ChevronRight size={16} />
            </span>
          </div>
          <span className="friends-circle-decoration" aria-hidden="true">
            ✳
          </span>
        </button>
        <button
          type="button"
          className={`friends-circle friends-circle-barkada ${openCircle === "Barkada" ? "friends-circle-selected" : ""}`}
          onClick={() =>
            setOpenCircle(openCircle === "Barkada" ? null : "Barkada")
          }
          aria-expanded={openCircle === "Barkada"}
          aria-controls="friends-circle-detail"
        >
          <span className="friends-circle-top">
            <span className="friends-circle-icon">
              <Users size={22} />
            </span>
            <ArrowUpRight size={20} />
          </span>
          <strong>Barkada</strong>
          <span>{barkadaMembers.length} people · sample circle</span>
          <div className="friends-circle-bottom">
            <AvatarStack ids={barkadaMembers} size={29} />
            <span className="friends-circle-arrow">
              <ChevronRight size={16} />
            </span>
          </div>
          <span className="friends-circle-decoration" aria-hidden="true">
            ✳
          </span>
        </button>
      </div>
      {openCircle && (
        <div id="friends-circle-detail" className="card friends-circle-detail">
          <div className="friends-section-title">
            <div>
              <span className="eyebrow">SAMPLE CIRCLE</span>
              <h3>
                Meet your {openCircle === "Pamilya" ? "pamilya" : "barkada"}
              </h3>
            </div>
            <button
              className="icon-button"
              aria-label="Close circle details"
              onClick={() => setOpenCircle(null)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="friends-member-list">
            {circleMembers.map((id) => (
              <div className="friends-member" key={id}>
                <Avatar id={id} size={38} />
                <span>
                  {id === "mika" ? identity.firstName : people[id].name}
                  {id === "mika" ? " (you)" : ""}
                </span>
                <span className="friends-member-sharing">
                  {id === "mika" ? "You control sharing" : "Sample member"}
                </span>
              </div>
            ))}
          </div>
          <p className="friends-circle-note">
            Everyone chooses when and with whom to share. Sample circle
            membership stays on this device.
          </p>
          <button className="button button-primary" onClick={onShare}>
            <MapPinIcon /> Share a journey
          </button>
        </div>
      )}
    </section>
  );

  return (
    <div className="friends-screen">
      <div className="friends-intro card">
        <div className="friends-intro-symbol" aria-hidden="true">
          <Users size={24} />
          <Sparkles size={15} />
        </div>
        <div>
          <h2>Good things start with your people.</h2>
          <p>Add a friend. Make a plan. Stay a little closer.</p>
        </div>
        <button
          className="button button-primary friends-add-button"
          onClick={onAddFriend}
        >
          <UserPlus size={17} /> Add friends
        </button>
      </div>
      <div className="friends-controls">
        <div className="friends-tabs" aria-label="People view">
          <button
            className={view === "friends" ? "friends-tab-active" : ""}
            onClick={() => setView("friends")}
            aria-pressed={view === "friends"}
          >
            Friends <span>{friendIds.length}</span>
          </button>
          <button
            className={view === "circles" ? "friends-tab-active" : ""}
            onClick={() => setView("circles")}
            aria-pressed={view === "circles"}
          >
            Circles <span>2</span>
          </button>
        </div>
        {view === "friends" && (
          <label className="friends-search">
            <Search size={17} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find your people"
              aria-label="Search friends"
            />
          </label>
        )}
      </div>
      {view === "friends" ? (
        <>
          {requestStatus === "pending" && !query && (
            <section
              className="friends-request card"
              aria-label="Friend request from Ana"
            >
              <div className="friends-request-header">
                <span className="friends-request-label">
                  <UserPlus size={13} /> A NEW CONNECTION
                </span>
                <span>2h ago</span>
              </div>
              <div className="friends-request-person">
                <Avatar id="ana" size={62} />
                <div>
                  <h3>Ana wants to connect</h3>
                  <p>You have 3 mutual friends. Small world, ’no?</p>
                </div>
                <span className="friends-request-spark" aria-hidden="true">
                  ✳
                </span>
              </div>
              <div className="friends-request-actions">
                <button className="button button-coral" onClick={onAccept}>
                  <Check size={16} /> Accept request
                </button>
                <button className="button friends-decline" onClick={onDecline}>
                  Decline
                </button>
              </div>
            </section>
          )}
          {requestStatus === "accepted" && !query && (
            <div className="friends-connected" role="status">
              <Check size={17} />
              <span>You and Ana are now friends. Tara, make a plan!</span>
            </div>
          )}
          <section className="card friends-list-card" aria-label="Your friends">
            <div className="friends-section-title">
              <h2>
                My friends{" "}
                <span className="friends-count">{friendIds.length}</span>
              </h2>
              <span className="friends-private">
                <LockKeyhole size={12} /> Private circle
              </span>
            </div>
            <div className="friends-list">
              {filteredFriends.map((id) => (
                <div className="friends-person-row" key={id}>
                  <Avatar id={id} size={51} />
                  <div className="friends-person-info">
                    <h3>{people[id].name}</h3>
                    <p>@{people[id].handle}</p>
                  </div>
                  <span className="friends-person-tag">
                    <Users size={12} /> Close friends
                  </span>
                  <div className="friends-menu-wrap">
                    <button
                      className="icon-button"
                      aria-label={`Options for ${people[id].name}`}
                      aria-expanded={openMenu === id}
                      onClick={() => setOpenMenu(openMenu === id ? null : id)}
                    >
                      <MoreHorizontal size={19} />
                    </button>
                    {openMenu === id && (
                      <div className="friends-person-menu">
                        <button
                          onClick={() => {
                            onRemoveFriend(id);
                            setOpenMenu(null);
                          }}
                        >
                          <UserMinus size={15} /> Remove friend
                        </button>
                        <button onClick={() => setOpenMenu(null)}>
                          <X size={15} /> Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {filteredFriends.length === 0 && (
              <div className="friends-empty">
                <Search size={28} />
                <h3>
                  {query ? "No friends found" : "Your people are out there"}
                </h3>
                <p>
                  {query
                    ? `Try another name or username.`
                    : "Add a friend to start making memories."}
                </p>
                {!query && (
                  <button
                    className="button button-primary"
                    onClick={onAddFriend}
                  >
                    Add your first friend
                  </button>
                )}
              </div>
            )}
          </section>
          {!query && circles}
        </>
      ) : (
        circles
      )}
      <div className="friends-privacy">
        <span className="friends-privacy-icon">
          <ShieldCheck size={22} />
        </span>
        <div>
          <strong>Your friendships. Your choice.</strong>
          <p>
            Adding friends never turns on location sharing. You choose who sees
            you, and when.
          </p>
        </div>
        <LockKeyhole className="friends-privacy-lock" size={29} />
      </div>
    </div>
  );
}

function MapPinIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}
