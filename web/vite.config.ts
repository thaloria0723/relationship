import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 多页:/ 、/grayview.html(灰模物理验收页)、/demo.html(§7 演示时间线页)、
// /luxview.html(模块③光影渲染页)
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        grayview: fileURLToPath(new URL("./grayview.html", import.meta.url)),
        demo: fileURLToPath(new URL("./demo.html", import.meta.url)),
        luxview: fileURLToPath(new URL("./luxview.html", import.meta.url)),
      },
    },
  },
});
