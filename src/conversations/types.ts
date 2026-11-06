import type { Profile } from "../account/types";

export interface PlanMessage {
  id: string;
  author: Profile;
  body: string;
  created_at: string;
}

export interface ConversationCursor { created_at: string; id: string }

export interface ConversationSnapshot {
  plan_id: string;
  messages: PlanMessage[];
  unread_count: number;
  has_more: boolean;
  next_before: ConversationCursor | null;
}

export interface ConversationsSnapshot {
  conversations: { plan_id: string; unread_count: number }[];
}
