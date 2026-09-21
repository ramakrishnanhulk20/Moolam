// X asks for its own route and the picture is the same one, so the card next
// door draws it and the two can never disagree. The segment settings are
// written out here because Next reads them from the file, not from a re-export.
export { default } from "./opengraph-image";

export const alt = "A Moolam passport: the registered picture, its seal and the block it was written in";
export const size = { width: 1200, height: 630 };
export const contentType = "image/jpeg";
export const runtime = "nodejs";
export const revalidate = 3600;
