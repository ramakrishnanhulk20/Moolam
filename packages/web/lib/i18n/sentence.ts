/**
 * The marks a title can end a sentence with, in the scripts the site speaks:
 * the Latin three, the ellipsis, the full-width CJK three and the Hindi danda.
 */
const STOPS = ".!?…。！？।";

/** True when the title already ends a sentence, so a template must not add a stop of its own after it. */
export function endsSentence(title: string): boolean {
  const trimmed = title.trimEnd();
  return trimmed !== "" && STOPS.includes(trimmed.slice(-1));
}

/**
 * The formatted sentence without the template's own stop when the title it
 * ends on already carries one: a title "God of War Kratos Fights against
 * Egyptian gods." put through "...the same picture as {title}." came out
 * "gods..". The sentence is the message as the translator wrote it, formatted;
 * the title is the value it was given. A title that stands mid-sentence, or
 * one that ends no sentence, leaves the sentence exactly as it was.
 */
export function withoutDoubleStop(sentence: string, title: string): string {
  const name = title.trimEnd();
  if (!endsSentence(name)) {
    return sentence;
  }
  const last = sentence.slice(-1);
  if (last === "" || !STOPS.includes(last)) {
    return sentence;
  }
  const body = sentence.slice(0, -1);
  return body.trimEnd().endsWith(name) ? body : sentence;
}
