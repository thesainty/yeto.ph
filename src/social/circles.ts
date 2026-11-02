import { supabase } from "../lib/supabase";

export const MAX_RECIPIENTS = 500;
export const MAX_CIRCLES = 50;

export interface AudienceCircle {
  id: string;
  name: string;
  member_ids: string[];
}

export class CircleError extends Error {
  constructor(message: string, readonly setupRequired = false) {
    super(message);
    this.name = "CircleError";
  }
}

export function circleError(cause: unknown): CircleError {
  if (cause instanceof CircleError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code) : "";
  if (["PGRST202", "PGRST205", "42P01"].includes(code)) {
    return new CircleError("Saved circles aren’t available yet. You can still choose friends for this item.", true);
  }
  if (code === "23505") return new CircleError("You already have a circle with that name. Choose another name.");
  if (["22023", "23514"].includes(code)) {
    return new CircleError("Use a circle name of 1–40 characters, up to 500 current friends, and at most 50 circles.");
  }
  if (["42501", "23503", "P0001"].includes(code)) {
    return new CircleError("This circle or one of its friends is no longer available. Refresh and review its members.");
  }
  return new CircleError("We couldn’t reach your saved circles. Please try again.");
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new CircleError("Sign in to save private circles.");
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data as T;
  } catch (cause) {
    throw circleError(cause);
  }
}

export async function fetchAudienceCircles(): Promise<AudienceCircle[]> {
  const data = await rpc<unknown>("audience_circles_snapshot");
  if (!Array.isArray(data) || data.some((circle) =>
    !circle || typeof circle.id !== "string" || typeof circle.name !== "string"
    || !Array.isArray(circle.member_ids) || circle.member_ids.some((id: unknown) => typeof id !== "string"))) {
    throw new CircleError("We couldn’t read your saved circles. Please refresh.");
  }
  return data as AudienceCircle[];
}

export const saveAudienceCircle = (id: string | null, name: string, memberIds: string[]) =>
  rpc<string>("save_audience_circle", { circle_id: id, circle_name: name.trim(), member_ids: [...memberIds] });

export const deleteAudienceCircle = (id: string) =>
  rpc<void>("delete_audience_circle", { circle_id: id });
