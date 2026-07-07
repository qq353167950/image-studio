# 部署指南（Vortexa / Pterodactyl + Cloudflare Tunnel）

本文档说明如何把 Image Studio 部署到 Vortexa（基于 Pterodactyl 的 Node.js 托管），
并通过 Cloudflare Tunnel 绑定自定义域名。

---

## 一、前置要点（务必先读）

Pterodactyl 面板和普通 Node 平台不同，有几个关键差异：

1. **端口是面板分配的**：容器通过环境变量 `SERVER_PORT` 注入端口（例如 `25959`），
   不是 `PORT`。代码已兼容：`process.env.SERVER_PORT || process.env.PORT || 3001`，
   并监听 `0.0.0.0`，无需手动配置端口。
2. **不会自动构建前端**：该 egg 只做 `npm install` + `node <MAIN_FILE>`，不跑 `npm run build`。
   而且容器内 Node 版本可能与 vite 不兼容（见"已知坑"），**所以前端必须本地构建好，
   把 `dist/` 一并提交进仓库**，容器直接使用。
3. **`/home/container` 是持久盘**：`data/store.json`（用户、历史）重启不丢，
   只有 Settings → Reinstall 才会清空。
4. **入口不是 `index.js`**：本项目入口是 `server/index.js`，Startup 页 `MAIN_FILE` 必须改。

---

## 二、面板配置（Startup 页）

走 Git 部署，只需核对以下几项，其余保持默认：

| 变量 | 值 | 说明 |
|------|-----|------|
| `GIT_ADDRESS` | `https://github.com/qq353167950/image-studio.git` | 仓库地址 |
| `BRANCH` | `main` | **注意**：老 egg 可能默认填 `master`，会拉不到，务必核对 |
| `MAIN_FILE` | `server/index.js` | 默认是 `index.js`，**必须改** |
| `AUTO_UPDATE` | `1`（开） | 每次启动自动 `git pull`，是"改代码后自动更新"的关键 |
| `USER_UPLOAD` | `0`（关） | 走 Git 部署就关掉；想手动传文件才开 |
| Git Username / Access Token | 留空 | 仓库是 public，不需要认证 |

环境变量（密钥、管理员密码等）不用配，默认值在代码里。

---

## 三、首次部署

1. 按上表填好 Startup 页并保存。
2. 如果容器是空的（DISK 显示 0 B），点 **Start 不会拉代码**——git clone 发生在
   **安装阶段**，不是启动阶段。此时去 **Settings → Reinstall Server** 强制跑安装：
   会执行 `git clone` + `npm install`。（容器为空时 Reinstall 无数据风险。）
3. 安装完成后自动进入启动，Console 应出现：
   ```
   Image Studio API running on http://<IP>:<SERVER_PORT>
   [tunnel] 启动 Cloudflare Tunnel，转发至 localhost:<SERVER_PORT> …
   Registered tunnel connection ...
   ```
4. 打开 `https://<你的域名>`，用 `admin` / `admin123` 登录。

---

## 四、Cloudflare Tunnel 配置

给项目绑定自定义域名 + 免费 HTTPS，容器无需开放额外端口。

### 1. 创建隧道
- Cloudflare 控制台 → **Zero Trust** → **Networks → Tunnels** → **Create a tunnel**
- 类型选 **Cloudflared** → 起名（如 `image-studio`）→ Save
- 在 "Install and run a connector" 页，复制命令里 `eyJ` 开头的那一整段 **token**
  （不要复制前面的 `cloudflared service install`）

### 2. 配置域名路由（Public Hostname）
- **Subdomain**：如 `img`（用根域名则留空）
- **Domain**：选你托管在 Cloudflare 的域名
- **Type**：`HTTP`
- **URL**：`localhost:<SERVER_PORT>`
  ⚠️ 端口必须是面板分配的 `SERVER_PORT`（如 `25959`），不是 3001
- Save

### 3. 放入 token
在面板 **Files → config/** 新建 `tunnel-token.txt`，粘入 token（整个文件只放这一串，
无多余空格换行）。此文件已被 `.gitignore` 排除，不会进仓库。

> 也可用环境变量 `CLOUDFLARE_TUNNEL_TOKEN`，代码优先读它，其次读该文件。

### 4. 重启
点 **Restart**，日志出现 `Registered tunnel connection` 即表示隧道已连上。
Cloudflare 隧道列表状态变绿（HEALTHY）也是同样含义。

---

## 五、日常更新流程（重要）

因为 `AUTO_UPDATE=1`，服务器会在启动时 `git pull`。所以更新分两种情况：

### 只改了后端（`server/` 等）
```bash
git add -A
git commit -m "..."
git push
```
然后面板 **Restart**。启动时 pull 到最新代码即可生效。

### 改了前端（`src/`、`index.html`、`vite.config.js`）
**必须本地重新构建并把 `dist/` 一起提交**，因为容器内不构建前端：
```bash
# 在 Git Bash 中执行（不要用 npm run build，Windows cmd 下会因 NODE_PATH 前缀报错）
./node_modules/.bin/vite build

git add -A            # 包含 dist/
git commit -m "..."
git push
```
然后面板 **Restart**。

> 判断更新是否生效：看启动日志第一行 git 结果。应显示 `Updating xxx..yyy` 并列出变更文件；
> 若显示 `Already up to date` 但你确实推了新代码，说明 pull 没生效，去 Settings 点一次
> **Reinstall**（数据在持久盘不丢）。

---

## 六、已知坑

- **容器 Node 版本偏低**：实测容器为 Node v21.7.3，而 vite 8 要求 20.19+ 或 22.12+，
  且 rolldown 缺 Linux 原生二进制，导致在服务器上 `vite build` 必然失败。
  **解决办法就是本项目采用的策略：本地构建，提交 `dist/`，容器直接托管。**
  代码里的自动构建只在 `dist/` 完全缺失时兜底尝试一次，正常流程不依赖它。
- **cloudflared 首次需联网下载**（约 36MB）。若容器禁外网导致
  `[tunnel] cloudflared 下载失败`，可手动下载对应平台二进制上传到 `bin/cloudflared`
  并加可执行权限。
- **公开仓库 + 默认密码**：`data/store.json` 含默认 `admin/admin123`，public 仓库任何人可见。
  正式使用请登录后修改密码。

---

## 七、备用：手动上传部署

不走 Git 也可以打包上传：

1. 本地构建：`./node_modules/.bin/vite build`
2. 打包（排除 `node_modules`、`.git`）：`server/ src/ config/ dist/ data/ index.html vite.config.js package.json package-lock.json README.md`
3. 面板 Startup 页把 `USER_UPLOAD` 开为 `1`
4. Files 页上传压缩包到 `/home/container`，右键 Unarchive 解压（注意不要多套一层目录）
5. `MAIN_FILE` 同样改为 `server/index.js`
6. Start（首次自动 `npm install`）

手动上传方式下 `config/tunnel-token.txt` 可直接打包带上（本地填好），无需在面板另建。
