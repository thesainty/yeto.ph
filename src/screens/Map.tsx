import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Coffee,
  LocateFixed,
  MapPin,
  Minus,
  Navigation,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Avatar } from "../components/ui";
import { people } from "../data";
import type { Circle, PersonId, Sharing } from "../types";
import "./map.css";

interface MapProps {
  sharing: Sharing | null;
  friendIds: PersonId[];
  onShare: () => void;
  onStop: () => void;
}

const mapPeople: Record<
  string,
  { id: PersonId; place: string; updated: string; left: string; top: string }[]
> = {
  Barkada: [
    {
      id: "bea",
      place: "Near High Street",
      updated: "1 min ago",
      left: "39%",
      top: "61%",
    },
    {
      id: "luis",
      place: "Near Market! Market!",
      updated: "3 min ago",
      left: "67%",
      top: "34%",
    },
  ],
  Pamilya: [
    {
      id: "paolo",
      place: "Near Burgos Circle",
      updated: "2 min ago",
      left: "33%",
      top: "41%",
    },
  ],
  "Close friends": [
    {
      id: "bea",
      place: "Near High Street",
      updated: "1 min ago",
      left: "39%",
      top: "61%",
    },
    {
      id: "luis",
      place: "Near Market! Market!",
      updated: "3 min ago",
      left: "67%",
      top: "34%",
    },
    {
      id: "paolo",
      place: "Near Burgos Circle",
      updated: "2 min ago",
      left: "25%",
      top: "37%",
    },
  ],
};

function Tree({
  x,
  y,
  small = false,
}: {
  x: number;
  y: number;
  small?: boolean;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${small ? 0.7 : 1})`}>
      <ellipse cx="1" cy="9" rx="9" ry="4" fill="#97bd91" opacity=".24" />
      <path
        d="M0 1v12"
        stroke="#92a378"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="-4" cy="-3" r="7" fill="#a8ce95" />
      <circle cx="4" cy="-4" r="8" fill="#b9da9d" />
      <circle cy="-9" r="7" fill="#c6e4aa" />
    </g>
  );
}

function MapArtwork({ compact = false }: { compact?: boolean }) {
  const colors = [
    "#e9e3d7",
    "#ece5da",
    "#e4dfd3",
    "#e9dfdb",
    "#e4e5d4",
    "#e0dfd4",
    "#e9e1d2",
  ];
  return (
    <svg
      className="map-artwork"
      viewBox="0 0 760 510"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id={compact ? "mini-map-grain" : "main-map-grain"}
          width="8"
          height="8"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="2" cy="2" r=".5" fill="#bdb4a5" opacity=".13" />
        </pattern>
      </defs>
      <rect width="760" height="510" fill="#f5f1e8" />
      <g transform="rotate(-16 380 255)">
        {Array.from({ length: 8 }, (_, col) =>
          Array.from({ length: 6 }, (_, row) => {
            const x = -58 + col * 115,
              y = -54 + row * 110;
            return (
              <g key={`${col}-${row}`}>
                <rect
                  x={x}
                  y={y}
                  width="94"
                  height="88"
                  rx="5"
                  fill={colors[(col * 3 + row) % colors.length]}
                />
                <rect
                  x={x + 6}
                  y={y + 7}
                  width="35"
                  height="34"
                  rx="3"
                  fill="#f2eee5"
                  opacity=".7"
                />
                <rect
                  x={x + 48}
                  y={y + 7}
                  width="39"
                  height="34"
                  rx="3"
                  fill="#fffaf3"
                  opacity=".45"
                />
                <rect
                  x={x + 8}
                  y={y + 48}
                  width="77"
                  height="32"
                  rx="3"
                  fill="#f4eee7"
                  opacity=".6"
                />
              </g>
            );
          }),
        )}
        <path d="M-20 269H820" stroke="#e2ddd1" strokeWidth="37" />
        <path d="M-20 269H820" stroke="#fffdf7" strokeWidth="28" />
        <path d="M393-100V650" stroke="#e2ddd1" strokeWidth="29" />
        <path d="M393-100V650" stroke="#fffdf7" strokeWidth="22" />
        <path
          d="M-20 269H820"
          stroke="#dfd3b8"
          strokeWidth="1.2"
          strokeDasharray="7 8"
        />
        <rect x="175" y="57" width="151" height="168" rx="12" fill="#d1e5bb" />
        <path
          d="M190 177Q236 151 263 178T316 191M249 65Q229 137 299 219"
          fill="none"
          stroke="#f5efdb"
          strokeWidth="5"
        />
        <rect x="520" y="302" width="132" height="115" rx="10" fill="#d0e2bb" />
        <path
          d="M526 384Q590 330 642 366"
          fill="none"
          stroke="#f4ecd7"
          strokeWidth="5"
        />
        <rect x="436" y="72" width="76" height="83" rx="7" fill="#e1d7ef" />
        <rect x="545" y="190" width="79" height="48" rx="7" fill="#f5deb3" />
        <rect x="68" y="304" width="82" height="78" rx="7" fill="#d6e5e7" />
        <rect x="291" y="307" width="73" height="78" rx="7" fill="#f0dcd6" />
        {[
          [192, 87],
          [308, 83],
          [186, 207],
          [309, 210],
          [209, 137],
          [291, 132],
          [552, 327],
          [627, 325],
          [543, 394],
          [630, 394],
          [463, 323],
          [695, 211],
          [692, 420],
          [93, 198],
          [96, 427],
          [476, 439],
          [341, 437],
          [83, 64],
          [677, 83],
        ].map(([x, y], i) => (
          <Tree key={i} x={x} y={y} small={i > 9} />
        ))}
        <text
          x="255"
          y="121"
          textAnchor="middle"
          fill="#689463"
          fontSize="13"
          fontWeight="700"
        >
          Greenway
        </text>
        <text
          x="255"
          y="138"
          textAnchor="middle"
          fill="#689463"
          fontSize="13"
          fontWeight="700"
        >
          Park
        </text>
        <text
          x="583"
          y="380"
          textAnchor="middle"
          fill="#6f925f"
          fontSize="12"
          fontWeight="600"
        >
          Track 30th
        </text>
        <text x="486" y="261" fill="#9b9688" fontSize="12" fontWeight="600">
          High Street
        </text>
        <text x="189" y="45" fill="#a29b8f" fontSize="11">
          30th Street
        </text>
        <text x="194" y="407" fill="#a29b8f" fontSize="11">
          26th Street
        </text>
        <text
          x="404"
          y="189"
          fill="#a29b8f"
          fontSize="11"
          transform="rotate(90 404 189)"
        >
          5th Avenue
        </text>
      </g>
      <rect
        width="760"
        height="510"
        fill={`url(#${compact ? "mini-map-grain" : "main-map-grain"})`}
      />
      <text
        x="345"
        y="256"
        fill="#9faaa4"
        fontSize="47"
        fontWeight="800"
        letterSpacing="4"
        opacity=".62"
      >
        BGC
      </text>
      <g transform="translate(425 343)">
        <circle r="18" fill="#ffc76e" stroke="#fffaf2" strokeWidth="3" />
        <path
          d="M-7-5H5V1A5 5 0 0 1-5 1V-5M5-3H8A3 3 0 0 1 8 3H5M-7 8H8"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </g>
      {!compact && (
        <text x="452" y="347" fill="#b08a50" fontSize="11" fontWeight="700">
          Coffee stop
        </text>
      )}
    </svg>
  );
}

export function MiniMap({
  onOpen,
  friendIds = ["bea", "luis"],
}: {
  onOpen?: () => void;
  friendIds?: PersonId[];
}) {
  return (
    <button
      type="button"
      className="map-mini"
      onClick={onOpen}
      aria-label="Open the demo circle map"
    >
      <MapArtwork compact />
      <span className="map-mini-label">
        <span className="map-mini-dot" /> Around your circle
      </span>
      {friendIds.includes("bea") && (
        <span className="map-mini-pin map-mini-pin-bea">
          <Avatar id="bea" size={34} />
        </span>
      )}
      {friendIds.includes("luis") && (
        <span className="map-mini-pin map-mini-pin-luis">
          <Avatar id="luis" size={34} />
        </span>
      )}
      <span className="map-mini-open">
        <ArrowUpRight size={17} />
      </span>
      <span className="map-mini-sample">Illustrated demo map</span>
    </button>
  );
}

export default function MapScreen({
  sharing,
  friendIds,
  onShare,
  onStop,
}: MapProps) {
  const [circle, setCircle] = useState<Circle>("Barkada");
  const [selected, setSelected] = useState<PersonId>("bea");
  const [zoom, setZoom] = useState(1);
  const [now, setNow] = useState(Date.now());
  const members = mapPeople[circle].filter((member) =>
    friendIds.includes(member.id),
  );
  const selectedMember =
    members.find((member) => member.id === selected) || members[0];
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(interval);
  }, []);
  const remaining =
    sharing?.durationMinutes == null
      ? null
      : Math.max(
          0,
          Math.ceil(
            (sharing.startedAt + sharing.durationMinutes * 60000 - now) / 60000,
          ),
        );
  function changeCircle(value: Circle) {
    setCircle(value);
    setSelected(
      mapPeople[value].find((member) => friendIds.includes(member.id))?.id ||
        "bea",
    );
  }
  return (
    <div className="map-screen">
      <div className="map-toolbar">
        <div>
          <h2>Your circle, a little closer.</h2>
          <p className="muted">Good company is never too far away.</p>
        </div>
        <label className="map-circle-picker">
          <Users size={16} />
          <select
            aria-label="Map circle"
            value={circle}
            onChange={(event) => changeCircle(event.target.value as Circle)}
          >
            <option>Barkada</option>
            <option>Pamilya</option>
            <option>Close friends</option>
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      <div className="map-canvas">
        <div className="map-scene" style={{ transform: `scale(${zoom})` }}>
          <MapArtwork />
          {members.map((member) => (
            <button
              key={member.id}
              className={`map-person-pin ${selectedMember?.id === member.id ? "map-person-pin-selected" : ""}`}
              style={{ left: member.left, top: member.top }}
              type="button"
              aria-label={`Show ${people[member.id].name}'s sample location`}
              aria-pressed={selectedMember?.id === member.id}
              onClick={() => setSelected(member.id)}
            >
              <span className="map-pin-avatar">
                <Avatar id={member.id} size={46} />
              </span>
              <span className="map-pin-name">{people[member.id].name}</span>
            </button>
          ))}
        </div>
        <span className="map-demo-badge">
          <span /> Demo map · sample locations
        </span>
        <div className="map-controls">
          <button
            type="button"
            aria-label="Center map"
            className="map-control"
            onClick={() => {
              setZoom(1);
              setSelected(members[0]?.id || "bea");
            }}
          >
            <LocateFixed size={19} />
          </button>
          <div className="map-zoom-controls">
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoom >= 1.6}
              className="map-control"
              onClick={() =>
                setZoom((value) =>
                  Math.min(1.6, Number((value + 0.2).toFixed(1))),
                )
              }
            >
              <Plus size={19} />
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              disabled={zoom <= 0.8}
              className="map-control"
              onClick={() =>
                setZoom((value) =>
                  Math.max(0.8, Number((value - 0.2).toFixed(1))),
                )
              }
            >
              <Minus size={19} />
            </button>
          </div>
        </div>
        {selectedMember && (
          <div className="map-selection-card">
            <span className="map-selection-icon">
              <MapPin size={16} />
            </span>
            <div>
              <strong>{selectedMember.place}</strong>
              <span>
                {people[selectedMember.id].name} · sample location, not live
              </span>
            </div>
            <span className="map-selection-wave">✦</span>
          </div>
        )}
      </div>
      <div
        className={`map-sharing-banner ${sharing ? "map-sharing-active" : ""}`}
      >
        <span className="map-sharing-icon">
          <Navigation size={20} fill="currentColor" />
        </span>
        <div>
          <strong>
            {sharing
              ? `Sharing with ${sharing.audience}`
              : "Your location, your choice."}
          </strong>
          <span>
            {sharing
              ? `${remaining === null ? "Until you stop" : `${remaining} min left`}${sharing.destination ? ` · ${sharing.destination}` : ""} · Demo session`
              : "Start a journey and choose who comes along."}
          </span>
        </div>
        <button
          type="button"
          className={sharing ? "map-stop-button" : "map-start-button"}
          onClick={sharing ? onStop : onShare}
        >
          {sharing ? "Stop sharing" : "Share a journey"}
        </button>
      </div>
      <section className="map-people-section">
        <div className="section-heading">
          <h2>
            On the map{" "}
            <span className="map-member-count">{members.length}</span>
          </h2>
          <span className="muted">Sample activity</span>
        </div>
        <div className="card map-members-card">
          {members.length === 0 && (
            <div className="map-empty">
              <Users size={26} />
              <strong>No friends to show yet</strong>
              <p>
                Your circle’s sample locations will appear here. Sharing is
                always a separate choice.
              </p>
            </div>
          )}
          {members.map((member) => (
            <button
              type="button"
              key={member.id}
              className={`map-member-row ${selectedMember?.id === member.id ? "map-member-selected" : ""}`}
              onClick={() => setSelected(member.id)}
              aria-label={`Select ${people[member.id].name} on map`}
            >
              <Avatar id={member.id} size={46} />
              <span className="map-member-name">
                <strong>{people[member.id].name}</strong>
                <span>Sample update · {member.updated}</span>
              </span>
              <span className="map-member-place">
                <MapPin size={13} />
                {member.place}
              </span>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </div>
      </section>
      <div className="map-privacy-note">
        <ShieldCheck size={20} />
        <p>
          <strong>A little peace of mind.</strong> You choose who sees your
          location, and for how long. This prototype uses sample locations and
          never tracks your device.
        </p>
      </div>
      <div className="map-bottom-note">
        <Coffee size={14} />
        <span>A map full of familiar faces. That’s the good stuff.</span>
      </div>
    </div>
  );
}
