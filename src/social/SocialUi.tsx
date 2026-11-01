import { RefreshCw, ShieldCheck } from "lucide-react";
import type { Profile } from "../account/types";
import { useSocial } from "./SocialProvider";
import "./social.css";

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function firstGlyph(value: string) {
  return segmenter ? Array.from(segmenter.segment(value))[0]?.segment ?? "" : Array.from(value)[0] ?? "";
}

export function PersonAvatar({ person }: { person: Profile }) {
  const initials = person.display_name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map(firstGlyph).join("").toLocaleUpperCase();
  return <span className="social-avatar" role="img" aria-label={person.display_name}>{initials || "T"}</span>;
}

export function SocialStatus() {
  const { data, error, setupRequired, refreshing, refresh, busy } = useSocial();
  return (
    <div className="social-status">
      <div className="social-refresh-row">
        <span className="social-muted">Private by choice. No location is collected.</span>
        <button type="button" className="button button-soft social-refresh" onClick={() => void refresh()} disabled={refreshing || busy} aria-label="Refresh feed and plans">
          <RefreshCw size={15} className={refreshing ? "social-spinning" : ""} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && (
        <div className="social-error" role="alert">
          <ShieldCheck size={19} />
          <div>
            {setupRequired && <strong>Feed and Plans setup is pending</strong>}
            <p>{error}</p>
          </div>
        </div>
      )}
      {!data && !error && (
        <div className="card social-empty" role="status">
          <strong>Loading your feed and plans…</strong>
          <p>Your account content stays separate from the anonymous demo.</p>
        </div>
      )}
    </div>
  );
}

export function socialDate(value: string, dateOnly = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    ...(dateOnly ? {} : { timeStyle: "short" as const }),
  }).format(date) + (dateOnly ? "" : " · Philippines");
}
