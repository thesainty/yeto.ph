import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { people } from "../data";
import type { PersonId } from "../types";
import { useIdentity } from "../account/useIdentity";
import "../account/identity.css";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`logo${compact ? " logo-compact" : ""}`}
      aria-label="TARA — Your people. A little closer."
    >
      <img className="tara-wordmark" src="/tara-wordmark.svg" alt="TARA" width="1090" height="380" />
      {!compact && <small>Your people. A little closer.</small>}
    </div>
  );
}

const looks: Record<
  PersonId,
  {
    skin: string;
    hair: string;
    shirt: string;
    style: "long" | "short" | "wave";
  }
> = {
  mika: { skin: "#b97049", hair: "#352b37", shirt: "#ff906f", style: "long" },
  bea: { skin: "#d49a75", hair: "#3d2b28", shirt: "#fbf0dd", style: "long" },
  luis: { skin: "#ba7d54", hair: "#252d3b", shirt: "#477a9e", style: "short" },
  paolo: { skin: "#ca8d62", hair: "#2e2c35", shirt: "#6c8274", style: "wave" },
  ana: { skin: "#b97854", hair: "#342b29", shirt: "#a7b68b", style: "long" },
  nico: { skin: "#d1a07b", hair: "#37302f", shirt: "#a08cc7", style: "wave" },
};

export function Avatar({
  id,
  size = 44,
  online = false,
}: {
  id: PersonId;
  size?: number;
  online?: boolean;
}) {
  const identity = useIdentity();
  if (id === "mika" && !identity.isDemo) {
    return (
      <span
        className="avatar avatar-identity"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(9, Math.round(size * 0.34)),
        }}
        role="img"
        aria-label={identity.displayName}
      >
        <span className="avatar-identity-initials" aria-hidden="true">
          {identity.initials}
        </span>
        {online && <i className="avatar-online" />}
      </span>
    );
  }
  const person = people[id];
  const look = looks[id];
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: person.color }}
      role="img"
      aria-label={person.name}
    >
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r="40" fill={person.color} />
        {look.style === "long" && (
          <path d="M19 68V34C19 3 62 3 63 34v35Z" fill={look.hair} />
        )}
        <path d="M8 85V74c0-12 13-19 32-19s32 7 32 19v11" fill={look.shirt} />
        <path d="M33 48h14v14c-4 7-10 7-14 0Z" fill={look.skin} />
        <ellipse cx="40" cy="35" rx="17" ry="22" fill={look.skin} />
        <ellipse cx="23" cy="38" rx="3" ry="5" fill={look.skin} />
        <ellipse cx="57" cy="38" rx="3" ry="5" fill={look.skin} />
        {look.style === "long" ? (
          <path
            d="M21 37C16 12 37 6 48 13c12 4 13 15 11 26-4-9-7-13-15-16-5 7-15 9-23 14Z"
            fill={look.hair}
          />
        ) : (
          <path
            d="M22 34C16 16 26 7 38 10c13-8 29 5 22 25l-5-11c-8 3-15 2-23-1Z"
            fill={look.hair}
          />
        )}
        <path
          d="m29 34 7-1m9 0 6 1"
          stroke={look.hair}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="32" cy="38" r="1.5" fill="#302c34" />
        <circle cx="48" cy="38" r="1.5" fill="#302c34" />
        <path
          d="m39 39-1 6h4"
          stroke="#9a6045"
          strokeWidth="1.2"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M33 49q7 7 14 0"
          fill="#fff9ee"
          stroke="#94543f"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      {online && <i className="avatar-online" />}
    </span>
  );
}

export function AvatarStack({
  ids,
  size = 29,
}: {
  ids: PersonId[];
  size?: number;
}) {
  return (
    <div className="avatar-stack">
      {ids.slice(0, 4).map((id) => (
        <Avatar key={id} id={id} size={size} />
      ))}
      {ids.length > 4 && (
        <span className="avatar-extra">+{ids.length - 4}</span>
      )}
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = dialogRef.current!;
    const focusable = () =>
      [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter((el) => el.offsetParent !== null);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      if (!items.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? descriptionId : undefined}
        tabIndex={-1}
      >
        <button
          className="icon-button modal-close"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
        <h2 id={titleId}>{title}</h2>
        {subtitle && (
          <p className="modal-subtitle" id={descriptionId}>
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
