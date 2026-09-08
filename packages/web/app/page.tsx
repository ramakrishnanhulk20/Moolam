import { redirect } from "next/navigation";
import { routing } from "@/lib/i18n/routing";

/** The bare domain goes to the default language. */
export default function RootPage() {
  redirect(`/${routing.defaultLocale}`);
}
