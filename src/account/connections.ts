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

const CONNECTION_PAGE_SIZE = 500;
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ;) {
    const { data, error, count } = await page(offset, offset + CONNECTION_PAGE_SIZE - 1);
    if (error) throw accountError(error);
    rows.push(...(data ?? []));
    offset += data?.length ?? 0;
    if (typeof count === "number") {
      if (offset >= count) return rows;
      if (!data?.length) throw new Error("Your friends list changed while loading. Please refresh it before choosing recipients.");
    } else if (!data || data.length < CONNECTION_PAGE_SIZE) return rows;
  }
}

interface FriendshipRow { id: string; user_a: string; user_b: string; created_at: string }
interface RequestRow { id: string; requester_id: string; recipient_id: string; status: string; created_at: string }
interface BlockRow { blocked_id: string; created_at: string }

export async function fetchConnections(userId: string): Promise<Connections> {
  const db = client();
  const [friends, requests, blocks] = await Promise.all([
    allRows<FriendshipRow>((from, to) => db
      .from("friendships")
      .select("id,user_a,user_b,created_at", { count: "exact" })
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .order("id").range(from, to)),
    allRows<RequestRow>((from, to) => db
      .from("friend_requests")
      .select("id,requester_id,recipient_id,status,created_at", { count: "exact" })
      .eq("status", "pending")
      .order("created_at", { ascending: false }).order("id").range(from, to)),
    allRows<BlockRow>((from, to) => db
      .from("blocks")
      .select("blocked_id,created_at", { count: "exact" })
      .order("created_at", { ascending: false }).order("blocked_id").range(from, to)),
  ]);
  const friendIds = friends.map((row) =>
    row.user_a === userId ? (row.user_b as string) : (row.user_a as string),
  );
  const requestIds = requests.map((row) =>
    row.requester_id === userId
      ? (row.recipient_id as string)
      : (row.requester_id as string),
  );
  const ids = [...new Set([...friendIds, ...requestIds])];
  const profiles: Profile[] = [];
  // Small profile batches avoid long URLs and the service's per-response row
  // limit. Publish the snapshot only after every page and profile batch loads.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const data = await allRows<Profile>((from, to) => db
      .from("profiles")
      .select("id,username,display_name", { count: "exact" })
      .in("id", batch).order("id").range(from, to));
    profiles.push(...data);
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const result = empty();
  result.friends = friendIds.flatMap((id) =>
    byId.has(id) ? [byId.get(id)!] : [],
  );
  for (const row of requests) {
    const incoming = row.recipient_id === userId;
    const otherId = incoming ? row.requester_id : row.recipient_id;
    const person = byId.get(otherId);
    if (!person) continue;
    const request = { ...row, person };
    if (incoming) result.incoming.push(request);
    else result.outgoing.push(request);
  }
  // Profile visibility is intentionally removed on block; never fetch hidden profile data.
  result.blocked = blocks.map((row) => ({
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
