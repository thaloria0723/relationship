// 光影查看器入口(luxview.html;模块③)
// viewer.ts 是全工程唯一 import three 的文件;本入口只做页面挂载。
import { mountLuxViewer } from "../grayview/viewer";

const app = document.getElementById("app");
if (app) {
  mountLuxViewer(app);
}
