import * as motion from "framer-motion/client";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AccountChip } from "@/components/account/account-chip";
import { Footer } from "@/components/footer";
import { MotionRoot } from "@/components/motion-root";
import { Wordmark } from "@/components/wordmark";

export const metadata: Metadata = {
  title: "Privacy | Dreamloom",
  description: "What Dreamloom keeps about a visit, what Google sign-in gives it, and where your picture and prompt go.",
};

const MOOLAM_ISSUES_URL = "https://github.com/ramakrishnanhulk20/Moolam/issues";
const GOOGLE_CONNECTIONS_URL = "https://myaccount.google.com/connections";

const EASE = [0.22, 1, 0.36, 1] as const;
const rise = { hidden: { opacity: 0, y: 24 }, shown: { opacity: 1, y: 0 } };

const CHAPTERS = [
  { id: "visit", title: "What a visit keeps" },
  { id: "google", title: "Signing in with Google" },
  { id: "sent", title: "What is sent where" },
  { id: "public", title: "What becomes public" },
  { id: "stop", title: "Signing out and stopping" },
  { id: "contact", title: "Questions" },
] as const;

type ChapterId = (typeof CHAPTERS)[number]["id"];

/**
 * Dreamloom's privacy page, written from what its code does today (lib/server and the components),
 * so every line here can be checked against a file. When the code changes what it keeps or sends,
 * this page changes with it.
 */
export default function PrivacyPage() {
  return (
    <MotionRoot>
      <div className="relative isolate overflow-clip">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="dream-cloud absolute -top-40 -left-40 size-[34rem] rounded-full bg-violet/20 blur-3xl" />
          <div className="dream-cloud absolute top-24 right-[-14rem] size-[32rem] rounded-full bg-tangerine/15 blur-3xl" />
          <div className="dream-cloud absolute top-[46rem] left-1/3 size-[26rem] rounded-full bg-sun/25 blur-3xl" />
        </div>

        <motion.nav
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="mx-auto flex max-w-[88rem] flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 pt-5 sm:px-10 sm:pt-7"
        >
          <a href="/" className="rounded-full transition-opacity hover:opacity-75">
            <Wordmark />
          </a>
          <AccountChip />
          <a
            href="/"
            className="inline-flex min-h-11 items-center rounded-full border-2 border-ink/10 bg-card/70 px-4 py-2 text-sm font-semibold text-ink backdrop-blur transition hover:-translate-y-0.5 hover:border-violet hover:text-violet"
          >
            Weave a picture
          </a>
        </motion.nav>

        <main className="mx-auto max-w-[88rem] px-5 pt-10 pb-20 sm:px-10 sm:pt-16 sm:pb-28">
          <motion.header initial="hidden" animate="shown" transition={{ staggerChildren: 0.1, delayChildren: 0.1 }}>
            <motion.p variants={rise} className="text-sm font-bold tracking-[0.14em] text-violet uppercase">
              Privacy
            </motion.p>
            <h1
              className="mt-3 font-display text-[clamp(3rem,9vw,8.5rem)] leading-[0.9] font-extrabold tracking-[-0.05em] text-ink"
              style={{ fontVariationSettings: '"opsz" 96, "wdth" 86' }}
            >
              <motion.span variants={rise} transition={{ duration: 0.8, ease: EASE }} className="block">
                What Dreamloom
              </motion.span>
              <motion.span
                variants={rise}
                transition={{ duration: 0.8, ease: EASE }}
                className="text-daybreak block pr-[0.04em] pb-[0.06em] sm:pl-[0.9em]"
              >
                keeps, and where
              </motion.span>
              <motion.span variants={rise} transition={{ duration: 0.8, ease: EASE }} className="block lg:pl-[2.2em]">
                it goes.
              </motion.span>
            </h1>
            <motion.p variants={rise} className="mt-7 max-w-[40rem] text-lg text-ink-soft sm:ml-[0.3em]">
              Dreamloom is a demo site built to show the Moolam platform kit. It is not a real company. This page says
              what its code does today, and nothing it does not.
            </motion.p>
          </motion.header>

          <div className="mt-14 grid gap-10 sm:mt-20 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16">
            <motion.aside
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.7, delay: 0.5, ease: EASE }}
              className="hidden lg:sticky lg:top-8 lg:block lg:self-start"
            >
              <p className="text-xs font-bold tracking-[0.14em] text-ink-soft uppercase">On this page</p>
              <ol className="mt-4 space-y-1 border-l-2 border-ink/10">
                {CHAPTERS.map((chapter, index) => (
                  <li key={chapter.id}>
                    <a
                      href={`#${chapter.id}`}
                      className="-ml-0.5 flex items-baseline gap-3 border-l-2 border-transparent py-1.5 pl-4 text-base font-semibold text-ink-soft transition hover:border-violet hover:text-violet"
                    >
                      <span className="font-mono text-xs tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                      {chapter.title}
                    </a>
                  </li>
                ))}
              </ol>
            </motion.aside>

            <div className="min-w-0 space-y-6 sm:space-y-8">
              <Chapter id="visit">
                <p>A visit can leave two cookies in your browser. Page scripts cannot read either of them, and neither is used for ads or tracking. Dreamloom runs no analytics.</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <Ticket name="dl_session" lasts="Until your browser ends its session">
                    A random number that ties the pictures you weave to this browser. It is set with your first picture or
                    your sign-in, and has no end date of its own.
                  </Ticket>
                  <Ticket name="dl_signin" lasts="10 minutes at most">
                    Set only while you are on Google&apos;s sign-in page. It points to that one sign-in, is read once when
                    Google sends you back, and is then cleared.
                  </Ticket>
                </div>
                <p>
                  On its server, Dreamloom keeps each picture you weave and the prompt it came from, filed under a hash of
                  your cookie, never the cookie itself. It keeps the newest 500 pictures across all visitors and removes the
                  oldest first.
                </p>
                <p>
                  If you ask Dreamloom to send your future pictures straight to your Moolam account, it keeps that wallet
                  address the same way until you press &ldquo;Forget my address&rdquo;. To cap how many pictures one place
                  can weave in a day, it counts weaves per internet address, stored only as a hash and reset each day.
                </p>
              </Chapter>

              <Chapter id="google">
                <p>
                  Signing in is optional. Dreamloom asks Google for two things: your Google account&apos;s id and your email
                  address. It uses the address only when Google says it has verified it.
                </p>
                <Facts
                  items={[
                    ["Where it is kept", "On Dreamloom's server, filed under a hash of your session cookie."],
                    ["How long", "Used for 30 days from sign-in, then Dreamloom asks Google again. Signing out deletes it at once."],
                    ["How it is shown", "Only masked: the first letter, four stars and the domain. It never goes in a link, a log line or another visitor's page."],
                  ]}
                />
                <p>
                  Dreamloom never asks for your name, your photo, your contacts, your mail or your files. Your Google
                  password stays on Google&apos;s own page and never reaches Dreamloom.
                </p>
              </Chapter>

              <Chapter id="sent">
                <Route to="OpenAI" what="Your prompt, exactly as you typed it">
                  To draw the picture. Nothing else about you goes with it.
                </Route>
                <Route to="Moolam's verify service" what="The picture, its title and the AI-use terms you picked">
                  To sign the picture and register its passport. The title starts as your prompt&apos;s first words unless you
                  change it.
                </Route>
                <Route to="Moolam" what="Your verified email, and only then">
                  When you are signed in and press &ldquo;Let Dreamloom hold it for me&rdquo;, so the passport can wait for
                  you at Moolam. Moolam keeps only a keyed hash of the address, which lets it match you when you sign in
                  there with the same address.
                </Route>
                <Route to="Monad" what="The wallet address you confirm">
                  When you claim a passport into your Moolam account, the move to that address is written on Monad.
                </Route>
              </Chapter>

              <Chapter id="public">
                <p>
                  A picture without a passport stays private on Dreamloom&apos;s server. Once it has a passport, some of it
                  is public for good:
                </p>
                <Facts
                  items={[
                    ["On Monad", "The passport, the wallet that holds it, its AI-use terms, and every transaction that registered or moved it."],
                    ["On IPFS", "The signed picture and its title. Dreamloom's own gallery shows them too."],
                    ["Never public", "Your email. It is not written to Monad or IPFS."],
                  ]}
                />
                <p className="rounded-2xl border-2 border-tangerine/30 bg-sun/15 px-5 py-4 font-semibold text-ink">
                  A blockchain cannot forget. Nobody, not Dreamloom and not Moolam, can delete a passport from Monad, and
                  anyone may keep a copy of what was pinned to IPFS. Treat both as permanent.
                </p>
              </Chapter>

              <Chapter id="stop">
                <ul className="space-y-3">
                  <Step>
                    <strong className="text-ink">Sign out</strong> from the corner at the top of any Dreamloom page, this one
                    included. That deletes the Google account Dreamloom kept for your session. Your pictures stay with the
                    session.
                  </Step>
                  <Step>
                    <strong className="text-ink">Forget my address</strong> removes a wallet address you asked Dreamloom to
                    remember.
                  </Step>
                  <Step>
                    <strong className="text-ink">Clear Dreamloom&apos;s cookies</strong> to end the session. The pictures on
                    the server then have no way back to you, and leave as newer pictures push the oldest out.
                  </Step>
                  <Step>
                    <strong className="text-ink">Remove Dreamloom from your Google account</strong> on{" "}
                    <InlineLink href={GOOGLE_CONNECTIONS_URL}>Google&apos;s third-party connections page</InlineLink>.
                  </Step>
                  <Step>
                    <strong className="text-ink">Say &ldquo;not mine&rdquo; at Moolam</strong> for a picture waiting under
                    your email that you do not want.
                  </Step>
                </ul>
              </Chapter>

              <Chapter id="contact">
                <p>
                  Dreamloom is part of the Moolam project. Ask anything about this page by opening an issue on{" "}
                  <InlineLink href={MOOLAM_ISSUES_URL}>Moolam&apos;s GitHub</InlineLink>.
                </p>
              </Chapter>
            </div>
          </div>
        </main>
      </div>
      <Footer />
    </MotionRoot>
  );
}

function Chapter({ id, children }: { id: ChapterId; children: ReactNode }) {
  const index = CHAPTERS.findIndex((chapter) => chapter.id === id);
  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: EASE }}
      className="relative scroll-mt-8 overflow-hidden rounded-[2rem] bg-card/95 p-6 shadow-[0_30px_70px_-40px_rgba(23,18,43,0.45)] ring-1 ring-ink/5 sm:p-10"
    >
      <span
        aria-hidden
        className="text-daybreak pointer-events-none absolute -top-5 right-4 font-display text-[clamp(5.5rem,12vw,9rem)] leading-none font-extrabold tracking-[-0.06em] opacity-20 select-none sm:right-8"
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <h2 className="relative max-w-[85%] font-display text-[clamp(1.85rem,3.6vw,2.9rem)] leading-[1] font-extrabold tracking-[-0.035em] text-ink">
        {CHAPTERS[index]!.title}
      </h2>
      <div className="relative mt-6 max-w-[46rem] space-y-5 text-base leading-relaxed text-ink-soft sm:text-lg">{children}</div>
    </motion.section>
  );
}

function Ticket({ name, lasts, children }: { name: string; lasts: string; children: ReactNode }) {
  return (
    <div className="flex overflow-hidden rounded-2xl bg-milk ring-1 ring-ink/10 transition duration-200 hover:-translate-y-0.5 hover:ring-violet/40">
      <div aria-hidden className="bg-daybreak w-2 shrink-0" />
      <div className="min-w-0 px-4 py-4">
        <p className="font-mono text-base font-semibold text-ink">{name}</p>
        <p className="mt-1 text-xs font-bold tracking-[0.12em] text-violet uppercase">{lasts}</p>
        <p className="mt-2 text-base leading-snug text-ink-soft">{children}</p>
      </div>
    </div>
  );
}

function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-2xl bg-ink/10 ring-1 ring-ink/10">
      {items.map(([label, value]) => (
        <div key={label} className="grid gap-1 bg-card px-4 py-3.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6">
          <dt className="text-sm font-bold text-ink">{label}</dt>
          <dd className="text-base leading-snug text-ink-soft">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Route({ to, what, children }: { to: string; what: string; children: ReactNode }) {
  return (
    <div className="group grid gap-2 border-b-2 border-dashed border-ink/10 pb-5 last:border-b-0 last:pb-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
      <p className="flex items-center gap-2 font-display text-xl leading-tight font-bold text-ink">
        <span aria-hidden className="bg-daybreak inline-block size-2.5 shrink-0 rounded-full transition group-hover:scale-150" />
        {to}
      </p>
      <div>
        <p className="font-semibold text-ink">{what}</p>
        <p className="mt-1">{children}</p>
      </div>
    </div>
  );
}

function Step({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="bg-daybreak mt-[0.6em] inline-block size-2 shrink-0 rounded-full" />
      <span>{children}</span>
    </li>
  );
}

function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-violet underline decoration-violet/30 underline-offset-4 transition hover:text-tangerine hover:decoration-tangerine"
    >
      {children}
    </a>
  );
}
