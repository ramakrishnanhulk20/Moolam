"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { IntentLink } from "@/components/shell/BottomBar";
import { Link } from "@/lib/i18n/routing";
import { Arrow, ItemMark } from "./marks";
import { isExternal, type MenuItem } from "./menu";
import { landAfterPress } from "./useMenu";

const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * One menu link: through the locale router for the app's own pages, and as a
 * plain new-tab link for Dreamloom. Verify and Explore are fetched on intent,
 * as the phone bar's tabs are; the rest only when pressed.
 */
export function MenuLink({
  item,
  current,
  className,
  onChoose,
  children,
}: {
  item: MenuItem;
  current: boolean;
  className: string;
  /** Called on the press, so the menu closes even where the route stays the same. */
  onChoose?: () => void;
  children: ReactNode;
}) {
  const shared = {
    onClick: () => {
      onChoose?.();
      landAfterPress(item.href);
    },
    "data-menu-link": item.key,
    "aria-current": current ? ("page" as const) : undefined,
    className: `${className} ${FOCUS}`,
  };
  if (isExternal(item.href)) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer" {...shared}>
        {children}
      </a>
    );
  }
  if (item.prefetch === "intent") {
    return (
      <IntentLink href={item.href} {...shared}>
        {children}
      </IntentLink>
    );
  }
  return (
    <Link href={item.href} prefetch={false} {...shared}>
      {children}
    </Link>
  );
}

/** The small mono tag on the page being read. Colour is never the only sign. */
function Here() {
  const t = useTranslations("menu");
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
      <span aria-hidden className="h-[6px] w-[6px] bg-accent" />
      {t("here")}
    </span>
  );
}

/** A tile: the mark and the arrow on top, the name and its line at the foot. */
export function Tile({ item, current, onChoose }: { item: MenuItem; current: boolean; onChoose?: () => void }) {
  const t = useTranslations("menu");
  const external = isExternal(item.href);
  return (
    <MenuLink
      item={item}
      current={current}
      onChoose={onChoose}
      className={`group relative flex h-full min-h-[8.75rem] flex-col justify-between gap-5 rounded-[8px] border p-5 transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-accent hover:bg-bg-raised ${
        current ? "border-accent bg-bg-raised" : "border-line bg-bg-raised/60"
      }`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className={`transition-colors duration-200 group-hover:text-accent ${current ? "text-accent" : "text-text-muted"}`}>
          <ItemMark name={item.mark} size={22} />
        </span>
        {current ? (
          <Here />
        ) : (
          <Arrow
            external={external}
            className="-translate-x-1.5 text-accent opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
          />
        )}
      </span>
      <span className="block">
        <span className="block font-display text-lg font-semibold leading-tight tracking-[-0.015em] text-text">
          {t(`items.${item.key}.name`)}
        </span>
        <span className="mt-1.5 block text-[15px] leading-snug text-text-muted">{t(`items.${item.key}.line`)}</span>
      </span>
    </MenuLink>
  );
}

/**
 * The first tile on a side: twice as tall, on the accent's soft wash, with the
 * site's knot cropped large in its corner like a seal pressed into paper. On
 * the business side it is the business page, which the side leads with.
 */
export function LeadTile({ item, current, onChoose }: { item: MenuItem; current: boolean; onChoose?: () => void }) {
  const t = useTranslations("menu");
  const external = isExternal(item.href);
  return (
    <MenuLink
      item={item}
      current={current}
      onChoose={onChoose}
      className={`grain group relative isolate flex h-full min-h-[18.5rem] flex-col justify-between overflow-hidden rounded-[8px] border bg-accent-soft p-6 transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-accent ${
        current ? "border-accent" : "border-accent/35"
      }`}
    >
      {/* The knot's own rule sets it relative, so a wrapper carries the place. */}
      <span
        aria-hidden
        className="absolute -bottom-16 -right-16 -z-10 h-64 w-64 opacity-[0.13] transition-transform duration-700 ease-out group-hover:rotate-45 group-hover:scale-110"
      >
        <span className="motif h-full w-full" />
      </span>
      <span className="flex items-start justify-between gap-3">
        <span className="text-accent">
          <ItemMark name={item.mark} size={34} />
        </span>
        {current ? <Here /> : null}
      </span>
      <span className="block">
        <span className="block font-display text-[2rem] font-semibold leading-[0.95] tracking-[-0.03em] text-text">
          {t(`items.${item.key}.name`)}
        </span>
        <span className="mt-3 block max-w-[26ch] text-base leading-snug text-text-muted">{t(`items.${item.key}.line`)}</span>
        <span className="mt-5 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
          {t("open")}
          <Arrow external={external} className="transition-transform duration-200 group-hover:translate-x-1" />
        </span>
      </span>
    </MenuLink>
  );
}
