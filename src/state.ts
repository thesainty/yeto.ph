import { initialState, people } from "./data";
import type { AppState, Circle, PersonId, Plan, Sharing } from "./types";

export const STORAGE_KEY = "yeto-demo-v1";
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const isPerson = (v: unknown): v is PersonId =>
  typeof v === "string" && Object.hasOwn(people, v);
const isPeople = (v: unknown): v is PersonId[] =>
  Array.isArray(v) && v.every(isPerson);
const isCircle = (v: unknown): v is Circle =>
  ["Close friends", "Pamilya", "Barkada"].includes(v as string);
function isSharing(v: unknown): v is Sharing {
  return (
    isObject(v) &&
    isCircle(v.audience) &&
    (v.durationMinutes === null ||
      (typeof v.durationMinutes === "number" &&
        v.durationMinutes > 0 &&
        v.durationMinutes <= 1440)) &&
    typeof v.startedAt === "number" &&
    Number.isFinite(v.startedAt) &&
    typeof v.destination === "string"
  );
}
function isPlan(v: unknown): v is Plan {
  return (
    isObject(v) &&
    ["id", "title", "place", "dateLabel", "time"].every(
      (k) => typeof v[k] === "string",
    ) &&
    ["coffee", "food", "trip"].includes(v.kind as string) &&
    isPeople(v.attendees) &&
    typeof v.joined === "boolean"
  );
}
export interface LoadedDemoState {
  state: AppState;
  storageUnavailable: boolean;
}

/** Read a single namespace without exposing another account's cached state. */
export function loadStateWithStatus(
  storageKey: string = STORAGE_KEY,
): LoadedDemoState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    return { state: structuredClone(initialState), storageUnavailable: true };
  }
  if (!raw) {
    return { state: structuredClone(initialState), storageUnavailable: false };
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (
      !isObject(data) ||
      !isPeople(data.friendIds) ||
      !isPeople(data.outgoingRequests) ||
      !["pending", "accepted", "declined"].includes(
        data.requestStatus as string,
      ) ||
      !Array.isArray(data.plans) ||
      !data.plans.every(isPlan) ||
      typeof data.liked !== "boolean" ||
      !Array.isArray(data.comments) ||
      !data.comments.every((v) => typeof v === "string") ||
      !(data.sharing === null || isSharing(data.sharing)) ||
      !Array.isArray(data.checkIns) ||
      !data.checkIns.every(
        (v) =>
          isObject(v) &&
          typeof v.id === "string" &&
          typeof v.message === "string" &&
          isCircle(v.audience),
      )
    )
      return {
        state: structuredClone(initialState),
        storageUnavailable: false,
      };
    const state = data as unknown as AppState;
    if (
      state.sharing &&
      state.sharing.durationMinutes !== null &&
      state.sharing.startedAt + state.sharing.durationMinutes * 60000 <=
        Date.now()
    )
      state.sharing = null;
    return { state, storageUnavailable: false };
  } catch {
    return { state: structuredClone(initialState), storageUnavailable: false };
  }
}

export function loadState(storageKey: string = STORAGE_KEY): AppState {
  return loadStateWithStatus(storageKey).state;
}
