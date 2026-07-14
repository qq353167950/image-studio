// 部署托管兜底：某些 Pterodactyl Node egg 的启动脚本形如
//   if [[ "${MAIN_FILE}" == "*.js" ]]; then node "${MAIN_FILE}"; else ts-node --esm "${MAIN_FILE}"; fi
// 该判断把 "*.js" 当字面量比较，普通入口（如 server/index.js）永远匹配不上，
// 于是被路由到 ts-node，而容器里的 ts-node 在较新 Node 上会崩溃。
//
// 规避办法：把面板变量 MAIN_FILE 设成字面量 *.js，命中 node 分支；
// 同时在此生成一个文件名就叫 `*.js` 的 ESM 引导文件，只负责加载真正的入口。
// node "/home/container/*.js" 在双引号内不做通配展开，会直接打开这个字面文件。
//
// 该文件仅在容器（Linux）安装阶段生成，不进仓库（见 .gitignore）。
// Windows 文件名不允许 `*`，本地生成会失败，直接忽略即可，不影响本地开发。

import { writeFileSync } from 'node:fs';

const ENTRY_NAME = '*.js';
const CONTENT = "import('./server/index.js');\n";

try {
  writeFileSync(ENTRY_NAME, CONTENT);
  console.log(`[prepare-entry] 已生成部署引导文件 ${ENTRY_NAME}`);
} catch (error) {
  console.log(`[prepare-entry] 跳过生成 ${ENTRY_NAME}（当前系统不支持该文件名，属正常情况）：${error.message}`);
}
