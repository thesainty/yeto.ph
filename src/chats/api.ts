import { supabase } from "../lib/supabase";
import type { Profile } from "../account/types";
import type { DirectChatSnapshot, DirectChatsSnapshot, DirectMessage, MessageCursor } from "./types";

export class DirectChatError extends Error {
  constructor(message: string, readonly setupRequired = false) {
    super(message);
    this.name = "DirectChatError";
  }
}
export function directChatError(cause: unknown): DirectChatError {
  if (cause instanceof DirectChatError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (["PGRST202", "PGRST205", "42P01"].includes(code)) {
    return new DirectChatError("Friend chats aren’t available yet. You can still use Friends and your plan conversations.", true);
  }
  if (["42501", "P0001"].includes(code)) {
    return new DirectChatError("This chat is no longer available. You can chat only with current, unblocked friends. Refresh and try again.");
  }
  if (["22023", "23514", "23503", "23505"].includes(code)) {
    return new DirectChatError("Choose a current friend and write a message of 1–1,000 characters. If the chat changed, refresh and try again.");
  }
  if (["PGRST301", "PGRST302", "invalid_jwt"].includes(code)) return new DirectChatError("Please sign in again to open your chats.");
  return new DirectChatError("We couldn’t reach your chats. Please refresh and try again.");
}
async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new DirectChatError("Sign in to chat with your friends.");
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data as T;
  } catch (cause) { throw directChatError(cause); }
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function profile(value: unknown): value is Profile {
  if (!value || typeof value !== "object") return false;
  const item = value as Profile;
  return typeof item.id === "string" && !!item.id && typeof item.display_name === "string" && typeof item.username === "string";
}
function message(value: unknown): value is DirectMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as DirectMessage;
  return typeof item.id === "string" && !!item.id && typeof item.body === "string" && timestamp(item.created_at) && profile(item.author);
}
function cursor(value: unknown): value is MessageCursor {
  if (!value || typeof value !== "object") return false;
  const item = value as MessageCursor;
  return typeof item.id === "string" && !!item.id && timestamp(item.created_at);
}
export async function fetchDirectChats(): Promise<DirectChatsSnapshot> {
  const data = await rpc<DirectChatsSnapshot>("direct_chats_snapshot");
  if (!data || !Array.isArray(data.chats) || data.chats.some((item) => !item || typeof item.id !== "string"
    || !profile(item.friend) || !timestamp(item.created_at) || !count(item.unread_count)
    || (item.last_message !== null && (!item.last_message || typeof item.last_message.id !== "string"
      || typeof item.last_message.body !== "string" || !timestamp(item.last_message.created_at) || typeof item.last_message.from_me !== "boolean")))) {
    throw new DirectChatError("We couldn’t read your chats. Please refresh.");
  }
  return data;
}
export const openDirectChat = (friendId: string) => rpc<string>("open_direct_chat", { friend_id: friendId });
export async function fetchDirectChat(id: string, before: MessageCursor | null = null): Promise<DirectChatSnapshot> {
  const data = await rpc<DirectChatSnapshot>("direct_chat_snapshot", { chat_id: id,
    before_created_at: before?.created_at ?? null, before_id: before?.id ?? null });
  if (!data || !data.chat || data.chat.id !== id || !profile(data.chat.friend) || !timestamp(data.chat.created_at)
    || !Array.isArray(data.messages) || data.messages.length > 50 || !data.messages.every(message)
    || !count(data.unread_count) || typeof data.has_more !== "boolean"
    || (data.has_more ? !cursor(data.next_before) : data.next_before !== null)) {
    throw new DirectChatError("We couldn’t read this chat. Please refresh.");
  }
  return data;
}
export const sendDirectMessage = (id: string, body: string, nonce: string) => rpc<string>("send_direct_message", {
  chat_id: id, body_text: body.trim(), client_nonce: nonce,
});
export const deleteDirectMessage = (id: string) => rpc<void>("delete_direct_message", { message_id: id });
export async function markDirectMessagesRead(id: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const selected = [...new Set(ids)];
  if (selected.length > 100) throw new DirectChatError("Read up to 100 loaded messages at a time.");
  await rpc<void>("mark_direct_messages_read", { chat_id: id, message_ids: selected });
}
