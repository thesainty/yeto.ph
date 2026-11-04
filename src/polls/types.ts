import type { Profile } from "../account/types";
import type { SocialPlan } from "../social/types";

export interface PollOption {
  id: string;
  starts_at: string;
  vote_count: number;
  voted_by_me: boolean;
}

export interface PlanPoll {
  id: string;
  owner: Profile;
  title: string;
  place: string;
  kind: SocialPlan["kind"];
  created_at: string;
  invitees: Profile[];
  options: PollOption[];
  closed_at: string | null;
  plan_id: string | null;
}

export interface PollSnapshot { polls: PlanPoll[] }

export interface PollInput {
  title: string;
  place: string;
  kind: SocialPlan["kind"];
  option_times: string[];
  invitee_ids: string[];
}
