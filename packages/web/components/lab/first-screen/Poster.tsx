import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import { Billing } from "./Billing";
import { Credit } from "./Credit";
import { Drift } from "./Drift";
import { Drop } from "./Drop";
import { Headline, MakeOne } from "./Headline";
import { isRead, type CopyReading, type Finding, type Read } from "./finding";
import { copyLine, day, recheckLine, statementLine } from "./lines";
import { SUMMARIES } from "./words";
import type { TrySample } from "@/lib/data/samples";

/**
 * Drawing A, the poster.
 *
 * One registered picture fills the frame behind everything, read from the
 * passport and sent through the image optimizer. The headline stands at the
 * bottom left over the foot of the picture, the drop hangs to the right like a
 * still pinned to the poster, and the finding is the credit block, with the
 * four sponsors as the billing line under it.
 *
 * On a phone the picture is the top band only and the words own everything
 * under it, the way the film is framed at 375.
 */
export function Poster({
  finding,
  copy,
  samples,
}: {
  finding: Read<Finding>;
  copy: Read<CopyReading>;
  samples: TrySample[];
}) {
  const record = isRead(finding) ? finding.read : null;

  return (
    <section
      data-drawing="a"
      data-motif="seal"
      className="grain relative isolate overflow-hidden bg-bg"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-[62svh] overflow-hidden lg:h-full">
        <Drift className="absolute inset-0">
          {record?.picture ? (
            <Picture
              sources={pictureSources(record.picture)}
              sizes="100vw"
              priority
              className="object-cover object-[50%_40%]"
            />
          ) : null}
        </Drift>
        {/* Two scrims: the poster's own, dark from the foot, and a side one so
            the headline never sits on the brightest part of the sky. */}
        <div className="absolute inset-0 bg-[linear-gradient(to_top,var(--bg)_0%,var(--bg)_22%,var(--scrim-from)_50%,var(--scrim-to)_92%)] lg:bg-[linear-gradient(to_top,var(--bg)_0%,var(--bg)_6%,var(--scrim-from)_30%,var(--scrim-to)_78%)]" />
        <div className="absolute inset-0 hidden bg-[linear-gradient(90deg,var(--scrim-from)_0%,var(--scrim-to)_55%)] lg:block" />
      </div>

      <div className="mx-auto flex min-h-[calc(100svh-var(--header-h))] w-full max-w-[100rem] flex-col px-5 pb-8 pt-[24svh] sm:px-8 sm:pt-[30svh] lg:px-14 lg:pt-[9svh]">
        {/* On a phone the drop comes straight after the line and the second
            call after it, so the thing to press is on the first screen. On a
            wide screen the drop stands beside both. */}
        <div className="grid flex-1 content-end gap-x-14 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,27rem)] lg:items-end">
          <Headline size="poster" className="lg:col-start-1 lg:row-start-1" />
          <div className="rise lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-end" style={{ animationDelay: "260ms" }}>
            <Drop samples={samples} look="poster" />
          </div>
          <MakeOne className="rise lg:col-start-1 lg:row-start-2" />
        </div>

        <div className="rise mt-8 border-t border-line-strong pt-5" style={{ animationDelay: "380ms" }}>
          {record === null ? (
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-failed">
              The finding could not be read this minute: {isRead(finding) ? "" : finding.failed}
            </p>
          ) : (
            <Credit
              title={record.title ?? "Untitled"}
              registered={day(record.registeredAt)}
              href={`/passport/${record.id}`}
              lines={[copyLine(copy), recheckLine(record), statementLine(record, SUMMARIES)]}
            />
          )}
          <Billing className="mt-5" />
        </div>
      </div>
    </section>
  );
}
