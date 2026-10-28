/**
 * Client entry for the steps mode: the Pixi floor from services, a React HUD
 * on top, and keyboard/tap input that goes through the instance connection.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ClientModeView } from "@gamez/ui-host";
import { Hud } from "./Hud.tsx";
import { createStepsController } from "./controller.ts";

function layer(extraCss: string): HTMLDivElement {
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;inset:0;${extraCss}`;
  return div;
}

export const stepsView: ClientModeView = {
  modeId: "steps",
  async mount(host, services) {
    const world = layer("");
    const hud = layer("pointer-events:none");
    host.append(world, hud);

    const renderer = services.createWorldRenderer();
    try {
      await renderer.init(world, services.manifest, services.assetBaseUrl);
    } catch (err) {
      renderer.destroy();
      world.remove();
      hud.remove();
      throw err;
    }

    const conn = services.connectInstance("steps");
    const controller = createStepsController(renderer, conn);
    const root = createRoot(hud);
    root.render(createElement(Hud, { controller }));

    return () => {
      root.unmount();
      controller.destroy();
      renderer.destroy();
      conn.close();
      world.remove();
      hud.remove();
    };
  },
};
