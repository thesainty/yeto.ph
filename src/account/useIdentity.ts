import { useAccount } from "./AccountProvider";

export interface Identity {
  isDemo: boolean;
  isSignedIn: boolean;
  displayName: string;
  firstName: string;
  username: string;
  initials: string;
}

const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemes(value: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(value), (part) => part.segment)
    : Array.from(value);
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function initialsForName(name: string): string {
  const parts = name.split(/\s+/u).filter(Boolean);
  const first = graphemes(parts[0] ?? "")[0] ?? "";
  const last = parts.length > 1 ? (graphemes(parts.at(-1) ?? "")[0] ?? "") : "";
  // Uppercasing can expand a character (for example ß); keep at most two glyphs.
  return (
    graphemes(`${first}${last}`.toLocaleUpperCase()).slice(0, 2).join("") || "Y"
  );
}

/** Resolve the shell identity without leaking another account's cached profile. */
export function useIdentity(): Identity {
  const { session, profile, loading } = useAccount();

  if (session) {
    const ownProfile = profile?.id === session.user.id ? profile : null;
    const name =
      cleanName(ownProfile?.display_name) ||
      cleanName(session.user.user_metadata?.display_name);
    return {
      isDemo: false,
      isSignedIn: true,
      displayName: name || "Your account",
      firstName: name ? name.split(/\s+/u)[0] : "friend",
      username: ownProfile?.username?.trim() ?? "",
      initials: name ? initialsForName(name) : "Y",
    };
  }

  if (loading) {
    return {
      isDemo: false,
      isSignedIn: false,
      displayName: "Your profile",
      firstName: "friend",
      username: "",
      initials: "Y",
    };
  }

  return {
    isDemo: true,
    isSignedIn: false,
    displayName: "Mika Reyes",
    firstName: "Mika",
    username: "mikareyes",
    initials: "MR",
  };
}
