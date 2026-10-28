import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [cloudflare()],
  // Dev server is shared on the tailnet (MagicDNS names end in .ts.net).
  server: { host: "0.0.0.0", allowedHosts: [".ts.net"] },
});
