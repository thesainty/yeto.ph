import type { AppState, PersonId } from "./types";
export const people: Record<
  PersonId,
  {
    name: string;
    fullName: string;
    handle: string;
    color: string;
    lastSeen: string;
  }
> = {
  mika: {
    name: "Mika",
    fullName: "Mika Reyes",
    handle: "mikareyes",
    color: "#f9d77e",
    lastSeen: "You",
  },
  bea: {
    name: "Bea",
    fullName: "Bea Santos",
    handle: "beasnts",
    color: "#f4b5b2",
    lastSeen: "Active 12 min ago",
  },
  luis: {
    name: "Luis",
    fullName: "Luis Garcia",
    handle: "luisgarcia",
    color: "#b7d2eb",
    lastSeen: "Active 28 min ago",
  },
  paolo: {
    name: "Paolo",
    fullName: "Paolo Cruz",
    handle: "paolocruz",
    color: "#d5caeb",
    lastSeen: "Active 2 hours ago",
  },
  nico: {
    name: "Nico",
    fullName: "Nico Domingo",
    handle: "nicodomingo",
    color: "#e8d3ef",
    lastSeen: "New connection",
  },
  ana: {
    name: "Ana",
    fullName: "Ana Dela Cruz",
    handle: "anadelacruz",
    color: "#d3e4bc",
    lastSeen: "New friend",
  },
};
export const initialState: AppState = {
  outgoingRequests: [],
  friendIds: ["bea", "luis", "paolo"],
  requestStatus: "pending",
  liked: false,
  comments: [],
  sharing: null,
  checkIns: [],
  plans: [
    {
      id: "coffee-bgc",
      title: "Coffee in BGC?",
      place: "Common Grounds BGC",
      dateLabel: "Tomorrow",
      time: "3:00 PM",
      kind: "coffee",
      attendees: ["bea", "luis", "paolo"],
      joined: false,
    },
    {
      id: "weekend-escape",
      title: "A little weekend escape",
      place: "Tagaytay, Cavite",
      dateLabel: "Sat, Nov 7",
      time: "6:00 AM",
      kind: "trip",
      attendees: ["luis", "bea"],
      joined: false,
    },
    {
      id: "dinner",
      title: "Good food, better company",
      place: "Poblacion, Makati",
      dateLabel: "Fri, Nov 6",
      time: "7:00 PM",
      kind: "food",
      attendees: ["paolo", "bea"],
      joined: false,
    },
  ],
};
