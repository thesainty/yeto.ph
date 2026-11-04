import { supabase } from "../lib/supabase";
import type { Profile } from "../account/types";
import type { SocialSnapshot } from "../social/types";

export type ActivityKind = "friend_request" | "friend_accepted" | "plan_invite" | "plan_rsvp" | "post_comment" | "post_like" | "poll_invite";
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  actor: Profile;
  created_at: string;
  read_at: string | null;
  post_id: string | null;
  plan_id: string | null;
  request_id: string | null;
  comment_id: string | null;
  plan_title: string | null;
  poll_id?: string | null;
  poll_title?: string | null;
  rsvp_going: boolean | null;
}
export interface ActivitySnapshot { items: ActivityItem[]; unread_count: number }

export class ActivityError extends Error {
  constructor(message: string, readonly setupRequired = false) { super(message); this.name = "ActivityError"; }
}
export function activityError(cause: unknown): ActivityError {
  if (cause instanceof ActivityError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (["PGRST202", "PGRST205", "42P01"].includes(code)) {
    return new ActivityError("Your activity inbox isn’t available yet. You can still check Friends, Home, and Plans.", true);
  }
  if (["42501", "PGRST301", "PGRST302", "invalid_jwt"].includes(code)) {
    return new ActivityError("This activity is no longer available. Refresh your inbox or sign in again.");
  }
  return new ActivityError("We couldn’t load your activity. Please try again.");
}
async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new ActivityError("Sign in to open your activity inbox.");
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data as T;
  } catch (cause) { throw activityError(cause); }
}
export async function fetchActivity(): Promise<ActivitySnapshot> {
  const data = await rpc<ActivitySnapshot>("activity_inbox_snapshot");
  const kinds: ActivityKind[] = ["friend_request", "friend_accepted", "plan_invite", "plan_rsvp", "post_comment", "post_like", "poll_invite"];
  if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.unread_count) || data.unread_count < 0
    || data.items.some((item) => !item || typeof item.id !== "string" || !kinds.includes(item.kind)
      || !item.actor || typeof item.actor.id !== "string" || typeof item.actor.display_name !== "string" || typeof item.actor.username !== "string"
      || typeof item.created_at !== "string" || (item.read_at !== null && typeof item.read_at !== "string")
      || (item.poll_id != null && typeof item.poll_id !== "string")
      || (item.poll_title != null && typeof item.poll_title !== "string")
      || (item.kind === "poll_invite" && (typeof item.poll_id !== "string" || !item.poll_id)))) {
    throw new ActivityError("We couldn’t read your activity. Please refresh.");
  }
  return data;
}
export async function markActivityRead(ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (ids.length > 100) throw new ActivityError("Mark up to 100 visible activities at a time.");
  await rpc<void>("mark_activity_read", { activity_ids: [...new Set(ids)] });
}
export async function fetchActivityTarget(postId: string | null, planId: string | null): Promise<SocialSnapshot> {
  const data = await rpc<SocialSnapshot>("activity_target_snapshot", { post_id: postId, plan_id: planId });
  if (!data || !Array.isArray(data.posts) || !Array.isArray(data.plans)) throw new ActivityError("We couldn’t open this item. Please try again.");
  return data;
}
