import { supabase } from "../lib/supabase";
import { accountError } from "./errors";
import type { Connections, Profile } from "./types";

function client() {
  if (!supabase) throw new Error("Connect the Supabase project first.");
  return supabase;
}
function empty(): Connections {
  return { friends: [], incoming: [], outgoing: [], blocked: [] };
}

export async function fetchConnections(userId: string): Promise<Connections> {
  const db = client();
  const [friends, requests, blocks] = await Promise.all([
    db
      .from("friendships")
      .select("id,user_a,user_b,created_at")
      .or(`user_a.eq.${userId},user_b.eq.${userId}`),
    db
      .from("friend_requests")
      .select("id,requester_id,recipient_id,status,created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    db
      .from("blocks")
      .select("blocked_id,created_at")
      .order("created_at", { ascending: false }),
  ]);
  for (const result of [friends, requests, blocks])
    if (result.error) throw accountError(result.error);
  const friendIds = (friends.data ?? []).map((row) =>
    row.user_a === userId ? (row.user_b as string) : (row.user_a as string),
  );
  const requestIds = (requests.data ?? []).map((row) =>
    row.requester_id === userId
      ? (row.recipient_id as string)
      : (row.requester_id as string),
  );
  const ids = [...new Set([...friendIds, ...requestIds])];
  let profiles: Profile[] = [];
  if (ids.length) {
    const { data, error } = await db
      .from("profiles")
      .select("id,username,display_name")
      .in("id", ids);
    if (error) throw accountError(error);
    profiles = data as Profile[];
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const result = empty();
  result.friends = friendIds.flatMap((id) =>
    byId.has(id) ? [byId.get(id)!] : [],
  );
  for (const row of requests.data ?? []) {
    const incoming = row.recipient_id === userId;
    const otherId = incoming ? row.requester_id : row.recipient_id;
    const person = byId.get(otherId);
    if (!person) continue;
    const request = { ...row, person };
    if (incoming) result.incoming.push(request);
    else result.outgoing.push(request);
  }
  // Profile visibility is intentionally removed on block; never fetch hidden profile data.
  result.blocked = (blocks.data ?? []).map((row) => ({
    id: row.blocked_id as string,
    display_name: "Blocked member",
    username: "",
  }));
  return result;
}
export async function searchPeople(query: string): Promise<Profile[]> {
  const search = query.trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9_]{3,40}$/.test(search))
    throw new Error(
      "Search using at least 3 letters, numbers, or underscores from a username.",
    );
  const { data, error } = await client().rpc("search_people", {
    search_text: search,
  });
  if (error) throw accountError(error);
  return data as Profile[];
}
async function mutate(name: string, args: Record<string, unknown>) {
  const { error } = await client().rpc(name, args);
  if (error) throw accountError(error);
}
export const sendFriendRequest = (targetId: string) =>
  mutate("send_friend_request", { target_id: targetId });
export const respondFriendRequest = (requestId: string, accept: boolean) =>
  mutate("respond_friend_request", {
    request_id: requestId,
    accept_request: accept,
  });
export const cancelFriendRequest = (requestId: string) =>
  mutate("cancel_friend_request", { request_id: requestId });
export const removeConnection = (targetId: string) =>
  mutate("remove_friend", { target_id: targetId });
export const blockPerson = (targetId: string) =>
  mutate("block_person", { target_id: targetId });
export const unblockPerson = (targetId: string) =>
  mutate("unblock_person", { target_id: targetId });
