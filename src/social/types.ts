import type { Profile } from "../account/types";

export type { Profile } from "../account/types";

export interface SocialComment {
  id: string;
  author: Profile;
  body: string;
  created_at: string;
}

export interface SocialPost {
  id: string;
  author: Profile;
  body: string;
  created_at: string;
  audience_count: number;
  liked_by_me: boolean;
  like_count: number;
  comments: SocialComment[];
}

export interface SocialPlan {
  id: string;
  owner: Profile;
  title: string;
  place: string;
  starts_at: string;
  kind: "coffee" | "food" | "trip";
  created_at: string;
  invitees: Profile[];
  attendees: Profile[];
}

export interface SocialSnapshot {
  posts: SocialPost[];
  plans: SocialPlan[];
}

export interface PlanInput {
  title: string;
  place: string;
  starts_at: string;
  kind: SocialPlan["kind"];
  invitee_ids: string[];
}
