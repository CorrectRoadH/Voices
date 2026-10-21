import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  plugins: [cloudflare()],
});
