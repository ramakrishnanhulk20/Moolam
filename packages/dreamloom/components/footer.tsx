import { Wordmark } from "./wordmark";

export const PLATFORM_DOCS_URL = "https://moolam.vercel.app/en/docs/developers/platform-kit";

export function Footer() {
  return (
    <footer className="relative overflow-hidden bg-ink text-white">
      <div aria-hidden className="bg-daybreak h-1.5 w-full" />
      <div className="mx-auto flex max-w-[88rem] flex-col gap-8 px-5 py-12 sm:px-10 sm:py-16 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Wordmark size="2.4rem" onDark />
          <p className="mt-4 max-w-[36rem] text-base text-white/75">
            Dreamloom is a demo site built to show the Moolam platform kit. It is not a real company.
          </p>
        </div>
        <a
          href={PLATFORM_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-2 self-start rounded-full border-2 border-white/20 px-5 py-3 text-base font-semibold text-white transition hover:border-sun hover:bg-white/5 hover:text-sun lg:self-auto"
        >
          How the Moolam platform kit works
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 11l6-6M6 5h5v5" />
          </svg>
        </a>
      </div>
    </footer>
  );
}
