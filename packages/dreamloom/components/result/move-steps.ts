import { sharedAddress, type MessageLike } from "./window-flow";

/**
 * The steps of moving a passport to the visitor's own Moolam account (D4). An address can only
 * arrive in a message from Moolam's exact origin, and it only ever leads to "confirm", which shows
 * the whole address. The request is sent only from "moving", and only a press of the confirm button
 * gets there.
 */
export type MoveState =
  | { kind: "idle" }
  | { kind: "waiting"; link: string; blocked: boolean }
  | { kind: "confirm"; address: string; link: string }
  | { kind: "moving"; address: string; link: string }
  | { kind: "problem"; words: string };

export type MoveEvent =
  | { type: "opened"; link: string; blocked: boolean }
  | { type: "message"; event: MessageLike; moolamOrigin: string | null }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "refused"; words: string };

export function moveStep(state: MoveState, event: MoveEvent): MoveState {
  switch (event.type) {
    case "opened":
      return { kind: "waiting", link: event.link, blocked: event.blocked };
    case "message": {
      // A second connect before the press replaces the address; it still has to be confirmed.
      if (state.kind !== "waiting" && state.kind !== "confirm") return state;
      const address = sharedAddress(event.event, event.moolamOrigin);
      return address === null ? state : { kind: "confirm", address, link: state.link };
    }
    case "confirm":
      return state.kind === "confirm" ? { kind: "moving", address: state.address, link: state.link } : state;
    case "cancel":
      return state.kind === "moving" ? state : { kind: "idle" };
    case "refused":
      return { kind: "problem", words: event.words };
  }
}

/** The question the confirm step asks, with the address in full so the visitor can check every character. */
export function confirmQuestion(address: string): string {
  return `Move this passport to ${address}?`;
}
