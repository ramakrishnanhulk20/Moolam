import Opening from "@/app/[locale]/loading";

/** A passport opens under its poster, so the wait holds the poster's height. */
export default function PassportLoading() {
  return <Opening frame="poster" />;
}
