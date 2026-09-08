import { getFormatter } from "next-intl/server";
import { DegradeSequence } from "@/components/hero/DegradeSequence";
import { HeroPoster } from "@/components/hero/HeroPoster";
import { degradeSteps, heroStill, measurement, passportCount } from "@/components/hero/still";
import { CHAIN_ID, addresses } from "@/lib/chain/client";

/**
 * The first screen and the moment under it, in one piece.
 *
 * Both reads happen here rather than in either child so the page makes one trip
 * to the chain, and the two dates are formatted on the server so English and
 * Tamil never disagree about how a date is written.
 */
export async function Hero({ locale }: { locale: string }) {
  const [still, passports, format] = await Promise.all([
    heroStill(),
    passportCount(),
    getFormatter({ locale }),
  ]);

  const stillDate =
    still === null ? null : format.dateTime(new Date(still.registeredAt * 1000), { dateStyle: "long" });

  return (
    <>
      <HeroPoster
        still={still}
        passports={passports}
        registry={addresses.registry}
        chainId={CHAIN_ID}
        stillDate={stillDate}
      />
      <DegradeSequence
        steps={degradeSteps()}
        stillUrl={still !== null && still.measured ? still.imageUrl : measurement.imageUrl}
        passportId={measurement.passportId}
        imageCid={measurement.imageCid}
        measuredOn={format.dateTime(new Date(measurement.measuredAt), { dateStyle: "long" })}
        exactConfidence={measurement.exactConfidence}
      />
    </>
  );
}
