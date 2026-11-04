import { supabase } from "../lib/supabase";
import type { Profile } from "../account/types";
import type { PlanPoll, PollInput, PollSnapshot } from "./types";

export class PollError extends Error {
  constructor(message: string, readonly setupRequired = false) {
    super(message);
    this.name = "PollError";
  }
}

export function pollError(cause: unknown): PollError {
  if (cause instanceof PollError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (["PGRST202", "PGRST205", "42P01"].includes(code)) {
    return new PollError("Availability polls aren’t available yet. You can still use your existing plans.", true);
  }
  if (["42501", "P0001"].includes(code)) {
    return new PollError("This poll is no longer available or your access has changed. Refresh and try again.");
  }
  if (["22023", "23514", "23503", "23505"].includes(code)) {
    return new PollError("Check the details, choose 2–5 different future times, and select up to 500 current friends. A closed poll can’t accept votes or create another plan.");
  }
  if (["PGRST301", "PGRST302", "invalid_jwt"].includes(code)) {
    return new PollError("Please sign in again to load your availability polls.");
  }
  return new PollError("We couldn’t reach your availability polls. Please refresh and try again.");
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new PollError("Sign in to create or answer availability polls.");
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data as T;
  } catch (cause) { throw pollError(cause); }
}

function isProfile(value: unknown): value is Profile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Profile;
  return typeof profile.id === "string" && typeof profile.username === "string" && typeof profile.display_name === "string";
}

function isPoll(value: unknown): value is PlanPoll {
  if (!value || typeof value !== "object") return false;
  const poll = value as PlanPoll;
  return typeof poll.id === "string" && isProfile(poll.owner) && typeof poll.title === "string"
    && typeof poll.place === "string" && ["coffee", "food", "trip"].includes(poll.kind)
    && typeof poll.created_at === "string" && Number.isFinite(Date.parse(poll.created_at))
    && Array.isArray(poll.invitees) && poll.invitees.every(isProfile)
    && Array.isArray(poll.options) && poll.options.length >= 2 && poll.options.length <= 5
    && poll.options.every((option) => option && typeof option.id === "string"
      && typeof option.starts_at === "string" && Number.isFinite(Date.parse(option.starts_at))
      && Number.isSafeInteger(option.vote_count) && option.vote_count >= 0 && typeof option.voted_by_me === "boolean")
    && (poll.closed_at === null || (typeof poll.closed_at === "string" && Number.isFinite(Date.parse(poll.closed_at))))
    && (poll.plan_id === null || typeof poll.plan_id === "string");
}

function snapshot(value: unknown): PollSnapshot {
  const result = value as PollSnapshot | null;
  if (!result || !Array.isArray(result.polls) || !result.polls.every(isPoll)) {
    throw new PollError("We couldn’t read your availability polls. Please refresh.");
  }
  return result;
}

export async function fetchPolls(): Promise<PollSnapshot> {
  return snapshot(await rpc<unknown>("plan_polls_snapshot"));
}

export async function fetchPollTarget(id: string): Promise<PollSnapshot> {
  return snapshot(await rpc<unknown>("plan_poll_target_snapshot", { poll_id: id }));
}

export const createPoll = (poll: PollInput) => rpc<string>("create_plan_poll", {
  poll_title: poll.title.trim(), poll_place: poll.place.trim(), poll_kind: poll.kind,
  option_times: [...poll.option_times], invitee_ids: [...poll.invitee_ids],
});
export const setPollVotes = (id: string, optionIds: string[]) =>
  rpc<void>("set_plan_poll_votes", { poll_id: id, option_ids: [...optionIds] });
export const convertPoll = (id: string, optionId: string) =>
  rpc<string>("convert_plan_poll", { poll_id: id, option_id: optionId });
export const deletePoll = (id: string) => rpc<void>("delete_plan_poll", { poll_id: id });
