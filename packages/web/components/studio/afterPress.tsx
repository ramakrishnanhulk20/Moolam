"use client";

import dynamic from "next/dynamic";

/**
 * The studio's parts that only exist once something has been pressed: the note
 * that says what went wrong and what to do next, and the done screen's two ways
 * on. Nobody who has not pressed anything downloads them.
 *
 * warmAfterPress is called in the same tick as the press, so both are on their
 * way while the button holds its acknowledgement and the run starts. A failure
 * that arrives before them, such as a refused file pick, still shows the moment
 * its chunk lands, a few hundredths of a second later.
 *
 * The run's progress band is not here on purpose: it has to be on screen in the
 * frame the form folds away, 220 ms after the tap, and a fetch cannot promise
 * that on a phone.
 */
export const FailureNote = dynamic(() => import("./FailureNote").then((module) => module.FailureNote));

export const DoneActions = dynamic(() => import("./DoneActions").then((module) => module.DoneActions));

export function warmAfterPress(): void {
  void import("./FailureNote");
  void import("./DoneActions");
}
