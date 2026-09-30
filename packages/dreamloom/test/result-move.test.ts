import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoveConfirm, MoveFlowView } from "@/components/result/move-flow";
import { confirmQuestion, moveStep, type MoveState } from "@/components/result/move-steps";

const SITE = "https://moolam.vercel.app";
const ORIGIN = "https://moolam.vercel.app";
const LINK = `${SITE}/en/connect?origin=${encodeURIComponent("https://dreamloom.example")}`;
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const OTHER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";

const message = (address: string, origin = ORIGIN) =>
  ({ type: "message", event: { origin, data: { type: "moolam:address", address } }, moolamOrigin: ORIGIN }) as const;

const noop = () => {};

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
}

describe("moving a passport asks first", () => {
  const waiting: MoveState = moveStep({ kind: "idle" }, { type: "opened", link: LINK, blocked: false });

  it("an address from Moolam leads to the confirm step with that exact address, not to a move", () => {
    const next = moveStep(waiting, message(ADDRESS.toLowerCase()));
    expect(next).toEqual({ kind: "confirm", address: ADDRESS, link: LINK });
  });

  it("only a press of confirm starts the move, with the confirmed address", () => {
    const confirm = moveStep(waiting, message(ADDRESS));
    expect(moveStep(confirm, { type: "confirm" })).toEqual({ kind: "moving", address: ADDRESS, link: LINK });
  });

  it("a confirm with no address in hand does nothing", () => {
    expect(moveStep(waiting, { type: "confirm" })).toBe(waiting);
    expect(moveStep({ kind: "idle" }, { type: "confirm" })).toEqual({ kind: "idle" });
  });

  it("a wrong origin or a bad address never reaches the confirm step", () => {
    expect(moveStep(waiting, message(ADDRESS, "https://evil.example"))).toBe(waiting);
    expect(moveStep(waiting, message("0x1234"))).toBe(waiting);
  });

  it("a second connect replaces the address and still has to be confirmed", () => {
    const confirm = moveStep(waiting, message(ADDRESS));
    expect(moveStep(confirm, message(OTHER))).toEqual({ kind: "confirm", address: OTHER, link: LINK });
  });

  it("no message changes a move already under way", () => {
    const moving = moveStep(moveStep(waiting, message(ADDRESS)), { type: "confirm" });
    expect(moveStep(moving, message(OTHER))).toBe(moving);
    expect(moveStep(moving, { type: "cancel" })).toBe(moving);
  });

  it("before a connect, a message is ignored", () => {
    expect(moveStep({ kind: "idle" }, message(ADDRESS))).toEqual({ kind: "idle" });
  });

  it("the confirm step shows the question with the whole address", () => {
    const markup = renderToStaticMarkup(createElement(MoveConfirm, { address: ADDRESS, onConfirm: noop, onCancel: noop }));
    expect(text(markup)).toContain(confirmQuestion(ADDRESS));
    expect(confirmQuestion(ADDRESS)).toBe(`Move this passport to ${ADDRESS}?`);
    expect(text(markup)).toContain("Yes, move it");
  });

  it("the confirm step is what the flow draws when an address arrives, and nothing says it is moving", () => {
    const state = moveStep(waiting, message(ADDRESS));
    const markup = renderToStaticMarkup(
      createElement(MoveFlowView, { state, onStart: noop, onReopen: noop, onConfirm: noop, onCancel: noop }),
    );
    expect(text(markup)).toContain(confirmQuestion(ADDRESS));
    expect(text(markup)).not.toContain("Moving the passport");
  });
});
