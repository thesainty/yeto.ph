import { supabase } from "../lib/supabase";
import type { ConversationCursor, ConversationSnapshot, ConversationsSnapshot, PlanMessage } from "./types";

export class ConversationError extends Error {
  constructor(message: string, readonly setupRequired = false) {
    super(message);
    this.name = "ConversationError";
  }
}

export function conversationError(cause: unknown): ConversationError {
  if (cause instanceof ConversationError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (["PGRST202", "PGRST205", "42P01"].includes(code)) {
    return new ConversationError("Plan conversations aren’t available yet. You can still use your plans.", true);
  }
  if (["42501", "P0001"].includes(code)) {
    return new ConversationError("This conversation or message is no longer available, or your access has changed. Refresh and try again.");
  }
  if (["22023", "23514", "23503", "23505"].includes(code)) {
    return new ConversationError("Write a message of 1–1,000 characters. If the conversation changed, refresh and try again.");
  }
  if (["PGRST301", "PGRST302", "invalid_jwt"].includes(code)) {
    return new ConversationError("Please sign in again to open your plan conversations.");
  }
  return new ConversationError("We couldn’t reach your plan conversations. Please refresh and try again.");
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new ConversationError("Sign in to use plan conversations.");
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    return data as T;
  } catch (cause) { throw conversationError(cause); }
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
function message(value: unknown): value is PlanMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as PlanMessage;
  return typeof item.id === "string" && !!item.id && typeof item.body === "string" && timestamp(item.created_at)
    && !!item.author && typeof item.author.id === "string" && typeof item.author.display_name === "string" && typeof item.author.username === "string";
}
function cursor(value: unknown): value is ConversationCursor {
  if (!value || typeof value !== "object") return false;
  const item = value as ConversationCursor;
  return typeof item.id === "string" && !!item.id && timestamp(item.created_at);
}

export async function fetchConversations(): Promise<ConversationsSnapshot> {
  const data = await rpc<ConversationsSnapshot>("plan_conversations_snapshot");
  if (!data || !Array.isArray(data.conversations) || data.conversations.some((item) => !item
    || typeof item.plan_id !== "string" || !count(item.unread_count))) {
    throw new ConversationError("We couldn’t read your unread message counts. Please refresh.");
  }
  return data;
}

export async function fetchConversation(id: string, before: ConversationCursor | null = null): Promise<ConversationSnapshot> {
  const data = await rpc<ConversationSnapshot>("plan_conversation_snapshot", {
    plan_id: id, before_created_at: before?.created_at ?? null, before_id: before?.id ?? null,
  });
  if (!data || data.plan_id !== id || !Array.isArray(data.messages) || data.messages.length > 50
    || !data.messages.every(message) || !count(data.unread_count) || typeof data.has_more !== "boolean"
    || (data.has_more ? !cursor(data.next_before) : data.next_before !== null)) {
    throw new ConversationError("We couldn’t read this conversation. Please refresh.");
  }
  return data;
}

export const sendMessage = (id: string, body: string, nonce: string) => rpc<string>("send_plan_message", {
  plan_id: id, body_text: body.trim(), client_nonce: nonce,
});
export const deleteMessage = (id: string) => rpc<void>("delete_plan_message", { message_id: id });
export async function markMessagesRead(id: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const selected = [...new Set(ids)];
  if (selected.length > 100) throw new ConversationError("Read up to 100 loaded messages at a time.");
  await rpc<void>("mark_plan_messages_read", { plan_id: id, message_ids: selected });
}
