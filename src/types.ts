export type Tab = "home" | "map" | "plans" | "friends" | "chats";
export type PersonId = "mika" | "bea" | "luis" | "paolo" | "ana" | "nico";
export type Circle = "Close friends" | "Pamilya" | "Barkada";
export interface Plan {
  id: string;
  title: string;
  place: string;
  dateLabel: string;
  time: string;
  kind: "coffee" | "trip" | "food";
  attendees: PersonId[];
  joined: boolean;
}
export interface Sharing {
  audience: Circle;
  durationMinutes: number | null;
  startedAt: number;
  destination: string;
}
export interface CheckIn {
  id: string;
  message: string;
  audience: Circle;
}
export interface AppState {
  outgoingRequests: PersonId[];
  friendIds: PersonId[];
  requestStatus: "pending" | "accepted" | "declined";
  plans: Plan[];
  liked: boolean;
  comments: string[];
  sharing: Sharing | null;
  checkIns: CheckIn[];
}
