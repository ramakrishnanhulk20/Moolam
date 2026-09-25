/** Which of the two drawings is on the bench. */
export type Drawing = "a" | "b";

/** The drawing asked for in the address. Anything but b opens the poster. */
export function drawingAsked(value: string | string[] | undefined): Drawing {
  return value === "b" ? "b" : "a";
}
