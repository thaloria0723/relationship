// 灰模查看器入口(grayview.html;物理验收页,零灯光零彩色)
import { mountGrayViewer } from "./viewer";

const app = document.getElementById("app");
if (app) {
  mountGrayViewer(app);
}
