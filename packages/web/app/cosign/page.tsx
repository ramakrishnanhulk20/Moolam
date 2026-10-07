import { redirect } from "next/navigation";
import { routing } from "@/lib/i18n/routing";

/**
 * The link a platform's kit builds has no language in it (https://moolam.site/cosign#handle).
 * It goes to the default language like the bare domain does; the browser carries the fragment, and
 * with it the handle, across the redirect, so the handle still never reaches this server.
 */
export default function BareCosignPage() {
  redirect(`/${routing.defaultLocale}/cosign`);
}
