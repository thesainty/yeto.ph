import { supabase } from "../lib/supabase";
import type { PlanInput, SocialSnapshot } from "./types";

export class SocialError extends Error {
  constructor(message: string, readonly setupRequired = false) {
    super(message);
    this.name = "SocialError";
  }
}

export function socialError(cause: unknown): SocialError {
  if (cause instanceof SocialError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : "";
  if (["PGRST202", "PGRST205", "42P01"].includes(code)) {
    return new SocialError(
      "Plans and the feed are not enabled yet. Your existing accounts and friendships are unchanged.",
      true,
    );
  }
  if (["42501", "P0001"].includes(code)) {
    return new SocialError(
      "This item is no longer available or you no longer have access. Refresh and try again.",
    );
  }
  if (["22023", "23514", "23503", "23505"].includes(code)) {
    return new SocialError(
      "Check the details, choose a future time for plans, and select only current friends.",
    );
  }
  if (["PGRST301", "PGRST302", "invalid_jwt"].includes(code)) {
    return new SocialError("Please sign in again to load your plans and feed.");
  }
  return new SocialError(
    "We couldn’t reach your saved plans and feed. Please refresh and try again.",
  );
}

function client() {
  if (!supabase) throw new SocialError("Sign in to use real plans and the feed.");
  return supabase;
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    const { data, error } = await client().rpc(name, args);
    if (error) throw error;
    return data as T;
  } catch (cause) {
    throw socialError(cause);
  }
}

export async function fetchSocial(): Promise<SocialSnapshot> {
  const data = await rpc<SocialSnapshot>("social_snapshot");
  if (!data || !Array.isArray(data.posts) || !Array.isArray(data.plans)) {
    throw new SocialError("We couldn’t read your saved plans and feed. Please refresh.");
  }
  return data;
}

export const createPost = (body: string, viewerIds: string[]) =>
  rpc<string>("create_social_post", { body_text: body.trim(), viewer_ids: viewerIds });

export const deletePost = (id: string) =>
  rpc<void>("delete_social_post", { post_id: id });

export const setLike = (id: string, liked: boolean) =>
  rpc<void>("set_social_like", { post_id: id, liked });

export const addComment = (id: string, body: string) =>
  rpc<string>("add_social_comment", { post_id: id, body_text: body.trim() });

export const deleteComment = (id: string) =>
  rpc<void>("delete_social_comment", { comment_id: id });

export const createPlan = (plan: PlanInput) =>
  rpc<string>("create_social_plan", {
    plan_title: plan.title.trim(),
    plan_place: plan.place.trim(),
    plan_starts_at: plan.starts_at,
    plan_kind: plan.kind,
    invitee_ids: plan.invitee_ids,
  });

export const deletePlan = (id: string) =>
  rpc<void>("delete_social_plan", { plan_id: id });

export const setAttendance = (id: string, going: boolean) =>
  rpc<void>("set_social_attendance", { plan_id: id, going });
