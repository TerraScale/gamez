import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { Slot, SlotProvider } from "../src/slots/react.tsx";
import { createSlotRegistry } from "../src/slots/registry.ts";

function Label({ text }: { text: string }) {
  return <span>{text}</span>;
}

describe("<Slot>", () => {
  it("renders registered components in order with the given props", () => {
    const registry = createSlotRegistry();
    registry.register("hud.left", {
      id: "b",
      moduleId: "m",
      component: ({ text }: { text: string }) => <span>B:{text}</span>,
      order: 2,
    });
    registry.register("hud.left", { id: "a", moduleId: "m", component: Label, order: 1 });
    const html = renderToStaticMarkup(
      <SlotProvider registry={registry}>
        <Slot name="hud.left" props={{ text: "hi" }} />
      </SlotProvider>,
    );
    expect(html).toBe("<span>hi</span><span>B:hi</span>");
  });

  it("renders the replacement after replace()", () => {
    const registry = createSlotRegistry();
    registry.register("hud.left", { id: "a", moduleId: "m", component: Label });
    registry.replace("hud.left", "a", () => <i>new</i>);
    const html = renderToStaticMarkup(
      <SlotProvider registry={registry}>
        <Slot name="hud.left" />
      </SlotProvider>,
    );
    expect(html).toBe("<i>new</i>");
  });

  it("renders nothing for an empty slot", () => {
    const html = renderToStaticMarkup(
      <SlotProvider registry={createSlotRegistry()}>
        <Slot name="hud.left" />
      </SlotProvider>,
    );
    expect(html).toBe("");
  });

  it("throws outside a provider", () => {
    expect(() => renderToStaticMarkup(<Slot name="hud.left" />)).toThrow(/SlotProvider/);
  });
});
