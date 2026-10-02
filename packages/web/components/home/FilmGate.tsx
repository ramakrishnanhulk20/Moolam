import { isValidElement, type ReactNode } from "react";
import { FilmBox } from "@/components/home/FilmBox";
import type { StoryData } from "@/components/story/data";
import { filmPages } from "@/components/story/stated";

/**
 * The screens of page the film will take, read off the data the story stage
 * inside it was handed.
 *
 * This runs on the server, where the stage is still a plain element carrying
 * the day's data. In the browser the same child arrives as a lazy reference
 * whose props cannot be read until it has loaded, which is why the box that
 * needs the number is handed it from here and does not look for it itself. A
 * child that carries no data is held at one screen.
 */
function reservedPages(children: ReactNode): number {
  if (isValidElement<{ data?: StoryData }>(children) && children.props.data !== undefined) {
    return filmPages(children.props.data);
  }
  return 1;
}

/**
 * The film's place on the home page, held open at the cut's own height and
 * filled with the film once the reader moves toward it (FilmBox.tsx).
 */
export function FilmGate({ children }: { children: ReactNode }) {
  return <FilmBox pages={reservedPages(children)}>{children}</FilmBox>;
}
