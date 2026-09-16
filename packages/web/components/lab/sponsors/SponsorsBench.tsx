import { isRead, type SponsorBench } from "@/lib/lab/sponsors";
import { ChainlinkAct } from "./ChainlinkAct";
import { EnvioAct } from "./EnvioAct";
import { MonadAct } from "./MonadAct";
import { PrivyAct } from "./PrivyAct";
import { Reveal } from "./Reveal";
import { Surface } from "./Surface";

/**
 * The sponsor bench: four places where the technology under this product is
 * real and silent, each drawn twice.
 *
 * Nothing links here, the labels are English on purpose, and every figure on it
 * is read from the chain, the index or the pinned documents on the request.
 * What Ram picks here is what rolls into the real screens.
 */
export function SponsorsBench({ bench }: { bench: SponsorBench }) {
  const reads: { name: string; ok: boolean }[] = [
    { name: "Monad", ok: isRead(bench.monad) },
    { name: "Privy", ok: isRead(bench.privy) },
    { name: "Chainlink", ok: isRead(bench.chainlink) },
    { name: "Envio", ok: isRead(bench.envio) },
  ];

  return (
    <Surface>
      <div className="px-5 pb-32 pt-10 sm:px-8 lg:px-14">
        <header className="mx-auto w-full max-w-[100rem]">
          <Reveal>
            <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent">
              <span className="motif h-[9px] w-[9px]" />
              Sponsor bench
            </p>
          </Reveal>

          {/* The title runs wider than the column under it and sits hard against
              the start edge, so the page opens on type rather than on a card. */}
          <Reveal delay={0.08}>
            <h1 className="mt-7 max-w-[16ch] font-display text-[clamp(3rem,10vw,9rem)] font-semibold uppercase leading-[0.85] tracking-[-0.055em]">
              Four sponsors. Nobody can tell.
            </h1>
          </Reveal>

          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-16">
            <Reveal delay={0.16}>
              <p className="max-w-[58ch] text-base leading-relaxed text-text-muted">
                The Monad, Privy, Chainlink and Envio work in this product is real and it is quiet. Each act below is
                one screen a judge already sees, drawn twice: as it reads today, and as it would read if the
                technology under it showed. Every figure on this page was read from the chain, the index or the pinned
                documents while this page was rendering. Nothing is typed in, and a source that would not answer costs
                its panel the number.
              </p>
            </Reveal>

            <Reveal delay={0.24}>
              <ul className="grid grid-cols-2 gap-px border border-line bg-line lg:mt-1">
                {reads.map((read) => (
                  <li key={read.name} className="bg-bg px-4 py-5">
                    <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                      <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${read.ok ? "bg-verified" : "bg-failed"}`} />
                      {read.ok ? "read live" : "no answer"}
                    </p>
                    <p className="mt-2 font-display text-[clamp(1.1rem,2vw,1.5rem)] font-semibold uppercase leading-[1] tracking-[-0.03em]">
                      {read.name}
                    </p>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </header>

        <div className="mx-auto mt-24 flex w-full max-w-[100rem] flex-col gap-28 lg:mt-36 lg:gap-40">
          <MonadAct reading={bench.monad} />
          <PrivyAct reading={bench.privy} />
          <ChainlinkAct reading={bench.chainlink} />
          <EnvioAct reading={bench.envio} />
        </div>
      </div>
    </Surface>
  );
}
