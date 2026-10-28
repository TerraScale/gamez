import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { SHELL_URLS } from "../../src/client/pwa/routing.ts";

const PUBLIC = new URL("../../public/", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, PUBLIC), "utf8");

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}
interface Manifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  theme_color: string;
  background_color: string;
  categories: string[];
  icons: ManifestIcon[];
}

const manifest = JSON.parse(read("manifest.webmanifest")) as Manifest;

/** Width and height from the IHDR chunk of a PNG (bytes 16..23). */
function pngSize(path: URL): { width: number; height: number; signature: boolean } {
  const bytes = readFileSync(path);
  const signature = bytes.subarray(1, 4).toString("ascii") === "PNG";
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), signature };
}

describe("manifest.webmanifest (wave-C.md §11)", () => {
  it("names the game and opens it standalone at the root", () => {
    expect(manifest.name).toBe("gamez");
    expect(manifest.short_name).toBe("gamez");
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.orientation).toBe("any");
    expect(manifest.categories).toContain("games");
  });

  it("matches the app colours (app.css --bg)", () => {
    const appCss = readFileSync(new URL("../../src/client/app/app.css", import.meta.url), "utf8");
    const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(appCss)?.[1]?.toLowerCase();
    expect(bg).toBe("#10131a");
    expect(manifest.background_color.toLowerCase()).toBe(bg);
    expect(manifest.theme_color.toLowerCase()).toBe(bg);
  });

  it("declares 192 and 512 icons with purpose any, and a maskable 512", () => {
    const find = (sizes: string, purpose: string) =>
      manifest.icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    expect(find("192x192", "any")).toBeDefined();
    expect(find("512x512", "any")).toBeDefined();
    expect(find("512x512", "maskable")).toBeDefined();
    for (const icon of manifest.icons) expect(icon.type).toBe("image/png");
  });

  it("every manifest icon exists as a PNG of the declared size", () => {
    for (const icon of manifest.icons) {
      const file = new URL(icon.src.replace(/^\//, ""), PUBLIC);
      expect(existsSync(file), icon.src).toBe(true);
      const [w, h] = icon.sizes.split("x").map(Number);
      const size = pngSize(file);
      expect(size.signature, icon.src).toBe(true);
      expect({ width: size.width, height: size.height }, icon.src).toEqual({ width: w, height: h });
    }
  });

  it("the iOS and favicon assets are PNGs of the declared size", () => {
    const apple = pngSize(new URL("icons/apple-touch-icon.png", PUBLIC));
    expect(apple).toMatchObject({ width: 180, height: 180, signature: true });
    const favicon = pngSize(new URL("icons/favicon-32.png", PUBLIC));
    expect(favicon).toMatchObject({ width: 32, height: 32, signature: true });
  });

  it("every precached shell path that is a file exists in public/", () => {
    for (const url of SHELL_URLS) {
      if (url === "/" || url === "/index.html") continue;
      expect(existsSync(new URL(url.replace(/^\//, ""), PUBLIC)), url).toBe(true);
    }
  });
});

describe("index.html PWA tags (wave-C.md §11)", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

  it("links the manifest, the icons and the theme colour", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />',
    );
    expect(html).toContain('href="/icons/favicon-32.png"');
    expect(html).toContain('<meta name="theme-color" content="#10131a" />');
  });

  it("sets the iOS standalone and status bar meta tags, and keeps viewport-fit=cover", () => {
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain("viewport-fit=cover");
  });

  it("keeps the original tags", () => {
    expect(html).toContain('<meta charset="UTF-8" />');
    expect(html).toContain('<meta name="color-scheme" content="dark" />');
    expect(html).toContain("<title>gamez</title>");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/src/client/main.ts"></script>');
  });
});

describe("main.ts", () => {
  it("registers the service worker after the app renders", () => {
    const main = readFileSync(new URL("../../src/client/main.ts", import.meta.url), "utf8");
    const render = main.indexOf("createRoot(root).render");
    const register = main.indexOf("void registerPwa();");
    expect(render).toBeGreaterThan(0);
    expect(register).toBeGreaterThan(render);
  });
});
