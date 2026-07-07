import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const binDir = join(rootDir, 'bin');

// cloudflared release binaries (pinned). Update the version if需要更新。
const CLOUDFLARED_VERSION = '2024.12.2';
const DOWNLOADS = {
  'linux-x64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
  'linux-arm64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64`
};

/**
 * 读取 tunnel token：优先环境变量，其次 config/tunnel-token.txt。
 * 返回 null 表示未配置，调用方应静默跳过。
 */
function resolveToken() {
  const fromEnv = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const tokenFile = join(rootDir, 'config', 'tunnel-token.txt');
  if (existsSync(tokenFile)) {
    const value = readFileSync(tokenFile, 'utf8').trim();
    // 忽略占位符（未替换的模板值）。
    if (value && value !== 'PASTE_YOUR_CLOUDFLARE_TUNNEL_TOKEN_HERE') return value;
  }
  return null;
}

function platformKey() {
  if (process.platform !== 'linux') return null;
  if (process.arch === 'arm64') return 'linux-arm64';
  if (process.arch === 'x64') return 'linux-x64';
  return null;
}

function ensureBinary() {
  const key = platformKey();
  if (!key) {
    console.warn(`[tunnel] 当前平台 ${process.platform}/${process.arch} 无内置 cloudflared 下载，跳过隧道。`);
    return null;
  }

  const target = join(binDir, 'cloudflared');
  if (existsSync(target)) return target;

  mkdirSync(binDir, { recursive: true });
  const url = DOWNLOADS[key];
  console.log(`[tunnel] 正在下载 cloudflared (${key})…`);

  try {
    // 优先 curl，其次 wget，两者容器里通常都有其一。
    try {
      execSync(`curl -fL --retry 3 -o "${target}" "${url}"`, { stdio: 'inherit' });
    } catch {
      execSync(`wget -O "${target}" "${url}"`, { stdio: 'inherit' });
    }
    chmodSync(target, 0o755);
    console.log('[tunnel] cloudflared 下载完成。');
    return target;
  } catch (error) {
    console.error('[tunnel] cloudflared 下载失败：', error?.message || error);
    return null;
  }
}

/**
 * 启动 Cloudflare Tunnel（token 模式）。公网域名 → localhost:port 的映射
 * 在 Cloudflare Zero Trust 后台配置，容器侧只需 token。
 */
export function startTunnel(port) {
  const token = resolveToken();
  if (!token) {
    console.log('[tunnel] 未配置 tunnel token，跳过（如需公网域名请配置 config/tunnel-token.txt）。');
    return;
  }

  const bin = ensureBinary();
  if (!bin) return;

  console.log(`[tunnel] 启动 Cloudflare Tunnel，转发至 localhost:${port} …`);
  const child = spawn(
    bin,
    ['tunnel', '--no-autoupdate', 'run', '--token', token],
    { stdio: 'inherit', env: process.env }
  );

  child.on('exit', (code) => {
    console.error(`[tunnel] cloudflared 退出 (code=${code})。`);
  });
  child.on('error', (error) => {
    console.error('[tunnel] cloudflared 启动失败：', error?.message || error);
  });

  // 主进程退出时一并关闭隧道。
  const cleanup = () => {
    try { child.kill(); } catch { /* noop */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
