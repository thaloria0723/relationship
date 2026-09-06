import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 多页:/(模块③接管前占位) 与 /grayview.html(灰模物理验收页)
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        grayview: fileURLToPath(new URL("./grayview.html", import.meta.url)),
      },
    },
  },
});
