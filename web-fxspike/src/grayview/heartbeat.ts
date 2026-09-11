// 后台心跳:rAF 在隐藏/后台标签中被浏览器暂停,仿真需要后台继续推进
// (demo 时间线、灰模验收不因标签切换而冻结)。隐藏时以 10Hz 发拍子,
// viewer 收到后只推进物理、跳过渲染;前台时本 worker 的拍子被忽略。
setInterval(() => self.postMessage(0), 100);
