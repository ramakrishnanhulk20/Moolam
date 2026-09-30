import { redirect } from "next/navigation";
import { routing } from "@/lib/i18n/routing";

/**
 * A platform may open the connect page without a language in the address. It goes to the default
 * language like the bare domain does, keeping the query, since ?origin= names the asking site.
 */
export default async function BareConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, one);
    }
  }
  const rest = query.toString();
  redirect(`/${routing.defaultLocale}/connect${rest === "" ? "" : `?${rest}`}`);
}
