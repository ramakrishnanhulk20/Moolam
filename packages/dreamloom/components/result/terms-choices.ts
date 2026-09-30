import type { TermsChoice } from "./picture-api";

/** The three AI-use choices, in the words a visitor sees. Each line says what the preset on the server writes. */
export const TERMS_OPTIONS: readonly { value: TermsChoice; name: string; line: string }[] = [
  { value: "noAi", name: "No AI use", line: "AI may not train on it, mine it or take it in as input." },
  { value: "open", name: "Open to AI", line: "AI may train on it, mine it and take it in as input." },
  { value: "askFirst", name: "Ask first", line: "AI use needs permission. The passport says to ask Dreamloom." },
];

export const DEFAULT_TERMS: TermsChoice = "noAi";
