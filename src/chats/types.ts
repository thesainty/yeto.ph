import type { Profile } from "../account/types";

export interface DirectMessage {
  id: string;
  author: Profile;
  body: string;
  created_at: string;
}
export interface MessageCursor { created_at: string; id: string }
export interface DirectChatSummary {
  id: string;
  friend: Profile;
  last_message: { id: string; body: string; created_at: string; from_me: boolean } | null;
  unread_count: number;
  created_at: string;
}
export interface DirectChatsSnapshot { chats: DirectChatSummary[] }
export interface DirectChatSnapshot {
  chat: { id: string; friend: Profile; created_at: string };
  messages: DirectMessage[];
  unread_count: number;
  has_more: boolean;
  next_before: MessageCursor | null;
}
