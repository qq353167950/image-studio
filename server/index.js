import express from 'express';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { startTunnel } from './tunnel.js';

const app = express();
// 关闭 ETag，避免 GET API 返回 304 让前端拿到空 body 而解析失败（弹窗打不开）。
app.set('etag', false);
const port = process.env.SERVER_PORT || process.env.PORT || 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');
const dataDir = join(__dirname, '..', 'data');
const storePath = join(dataDir, 'store.json');
const modelConfigPath = join(__dirname, '..', 'config', 'models.json');
const tokenSecret = process.env.APP_TOKEN_SECRET || 'image-studio-local-secret';
const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
const maxInputImageLength = Number(process.env.MAX_INPUT_IMAGE_LENGTH || 1_400_000);
const maxInputImagesTotalBytes = Number(process.env.MAX_INPUT_IMAGES_TOTAL_BYTES || 8 * 1024 * 1024);
const historyRetentionDays = Number(process.env.HISTORY_RETENTION_DAYS || 60);
const historyRetentionMs = historyRetentionDays * 24 * 60 * 60 * 1000;
const runningJobs = new Map();
const jobSubscribers = new Map();
const clientDiagnostics = [];

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '16mb' }));

// API 响应一律不缓存，避免 304 导致前端拿到空 body。
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const providers = loadModelConfig();

const progressSteps = [
  { progress: 12, message: '已接收任务，正在校验提示词' },
  { progress: 28, message: '正在准备模型参数和参考图' },
  { progress: 46, message: '模型已开始生成主体构图' },
  { progress: 68, message: '正在细化画面细节和光影' },
  { progress: 86, message: '正在保存图片和生成历史记录' }
];

const store = loadStore();
pruneExpiredJobs();
resumeRunningJobs();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/diagnostics/client', (req, res) => {
  const entry = {
    at: new Date().toISOString(),
    event: String(req.body?.event || 'unknown'),
    path: String(req.body?.path || ''),
    detail: req.body?.detail || {}
  };
  clientDiagnostics.push(entry);
  if (clientDiagnostics.length > 200) clientDiagnostics.splice(0, clientDiagnostics.length - 200);
  console.log(`[client-diagnostic] ${entry.event} ${entry.path} ${JSON.stringify(entry.detail)}`);
  res.json({ ok: true });
});

app.get('/api/diagnostics/client', (_req, res) => {
  res.json({ events: clientDiagnostics.slice(-80) });
});

app.get('/api/models', (_req, res) => {
  res.json({ providers: providers.map(publicProvider) });
});

app.post('/api/auth/login', (req, res) => {
  const credentials = normalizeCredentials(req.body ?? {});
  const validationError = validateCredentials(credentials, { allowAdmin: true });
  if (validationError) return res.status(400).json({ error: validationError });

  const existing = store.users.find((item) => item.username === credentials.username);
  if (!existing || existing.password !== credentials.password) {
    return res.status(401).json({ error: '账号或密码不正确。' });
  }

  res.json({
    token: createToken(existing),
    user: publicUser(existing)
  });
});

app.post('/api/auth/register', (req, res) => {
  const credentials = normalizeCredentials(req.body ?? {});
  const validationError = validateCredentials(credentials, { allowAdmin: false });
  if (validationError) return res.status(400).json({ error: validationError });

  const existing = store.users.find((item) => item.username === credentials.username);
  if (existing) {
    return res.status(409).json({ error: '账号已存在，请换一个账号。' });
  }

  const user = createUser(credentials.username, credentials.password);
  saveStore();

  res.status(201).json({
    token: createToken(user),
    user: publicUser(user)
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.put('/api/me/password', requireAuth, (req, res) => {
  const currentPassword = stripSpaces(req.body?.currentPassword);
  const newPassword = stripSpaces(req.body?.newPassword);

  if (!currentPassword) return res.status(400).json({ error: '请输入当前密码。' });
  if (req.user.password !== currentPassword) return res.status(401).json({ error: '当前密码不正确。' });

  const validationError = validatePassword(newPassword);
  if (validationError) return res.status(400).json({ error: validationError });
  if (newPassword === currentPassword) return res.status(400).json({ error: '新密码不能和当前密码相同。' });

  req.user.password = newPassword;
  req.user.passwordUpdatedAt = new Date().toISOString();
  saveStore();

  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: userOwnSettings(req.user) });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const normalized = normalizeUserSettings(req.body ?? {});
  const validationError = validateUserSettings(normalized);
  if (validationError) return res.status(400).json({ error: validationError });

  const currentSettings = userOwnSettings(req.user);
  if (isMaskedSecret(normalized.apiKey)) normalized.apiKey = currentSettings.apiKey;
  if (isMaskedSecret(normalized.grokApiKey)) normalized.grokApiKey = currentSettings.grokApiKey;

  req.user.settings = {
    ...filledSettings(normalized),
    updatedAt: new Date().toISOString()
  };
  saveStore();

  res.json({ settings: publicSettings(req.user.settings) });
});

app.get('/api/admin/settings', requireAuth, requireAdmin, (_req, res) => {
  res.json({ settings: adminDefaultSettings() });
});

app.put('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const normalized = normalizeUserSettings(req.body ?? {});
  const validationError = validateUserSettings(normalized);
  if (validationError) return res.status(400).json({ error: validationError });

  const currentSettings = adminDefaultSettings();
  if (isMaskedSecret(normalized.apiKey)) normalized.apiKey = currentSettings.apiKey;
  if (isMaskedSecret(normalized.grokApiKey)) normalized.grokApiKey = currentSettings.grokApiKey;

  store.settings = {
    ...currentSettings,
    ...normalized,
    updatedAt: new Date().toISOString()
  };
  saveStore();

  res.json({ settings: publicSettings(store.settings) });
});

app.post('/api/settings/models', requireAuth, async (req, res) => {
  const { providerId, mode } = req.body ?? {};
  const provider = providers.find((item) => item.id === providerId) || providers[0];

  if (!provider) return res.status(400).json({ error: '当前没有可用模型配置。' });

  try {
    const baseSettings = mode === 'admin' && req.user.role === 'admin' ? adminDefaultSettings() : userOwnSettings(req.user);
    const settings = mergeDraftSettings(baseSettings, req.body?.settings);
    const apiKey = provider.id === 'grok' ? resolvedValue(settings.grokApiKey, '', process.env[provider.apiKeyEnv]) : resolvedValue(settings.apiKey, '', process.env[provider.apiKeyEnv]);
    const baseUrl = provider.id === 'grok' ? resolvedValue(settings.grokBaseUrl, '', '') : resolvedValue(settings.baseUrl, '', '');

    if (!baseUrl) {
      return res.status(400).json({ error: `请先填写 ${provider.id === 'grok' ? 'Grok' : 'GPT'} Base URL。` });
    }

    if (!/^https?:\/\//.test(baseUrl)) {
      return res.status(400).json({ error: `${provider.id === 'grok' ? 'Grok' : 'GPT'} Base URL 必须以 http:// 或 https:// 开头。` });
    }

    if (!apiKey) {
      return res.status(400).json({ error: `请先填写 ${provider.id === 'grok' ? 'Grok' : 'GPT'} API Key。` });
    }

    const response = await fetch(routeFromBaseUrl(baseUrl, '/v1/models'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    const bodyText = await response.text();
    const body = parseJsonBody(bodyText);
    if (response.status === 401 || response.status === 403) throw new Error(`${provider.id === 'grok' ? 'Grok' : 'GPT'} API Key 无效或权限不足。`);
    if (response.status === 404) throw new Error(`${provider.id === 'grok' ? 'Grok' : 'GPT'} Base URL 无法访问 /v1/models，请检查接口地址。`);
    if (!response.ok) throw new Error(body?.error?.message || `模型列表获取失败，接口返回 HTTP ${response.status}。`);

    const models = Array.isArray(body.data) ? body.data.map((item) => item.id).filter(Boolean) : [];
    if (!models.length) return res.status(400).json({ error: '接口已响应，但没有返回可用模型列表。' });
    res.json({ models });
  } catch (error) {
    const message = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(error.message)
      ? `${provider.id === 'grok' ? 'Grok' : 'GPT'} Base URL 连接失败，请检查接口地址是否正确。`
      : error.message;
    res.status(400).json({ error: message });
  }
});

app.get('/api/jobs', requireAuth, (req, res) => {
  const jobs = visibleJobs(req.user)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((job) => publicJob(job, req.user));
  res.json({ jobs });
});

app.get('/api/jobs/active', requireAuth, (req, res) => {
  const jobs = visibleJobs(req.user)
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((job) => publicJob(job, req.user));
  res.json({ jobs });
});

app.get('/api/jobs/:id/events', requireAuth, (req, res) => {
  const job = store.jobs.find((item) => item.id === req.params.id);
  if (!job || !canViewJob(req.user, job)) {
    return res.status(404).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const subscribers = jobSubscribers.get(job.id) || new Set();
  subscribers.add(res);
  jobSubscribers.set(job.id, subscribers);
  sendJobEvent(res, job, req.user);

  req.on('close', () => {
    subscribers.delete(res);
    if (!subscribers.size) jobSubscribers.delete(job.id);
  });
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = store.jobs.find((item) => item.id === req.params.id);
  if (!job || !canViewJob(req.user, job)) {
    return res.status(404).json({ error: '记录不存在。' });
  }

  res.json({ job: publicJob(job, req.user) });
});

app.get('/api/jobs/:id/image', requireAuth, (req, res) => {
  const job = store.jobs.find((item) => item.id === req.params.id);

  if (!job || !canViewJob(req.user, job) || !job.imageUrl) {
    return res.status(404).json({ error: '图片不存在。' });
  }

  sendDataImage(res, job.imageUrl);
});

app.get('/api/jobs/:id/references/:refId', requireAuth, (req, res) => {
  const job = store.jobs.find((item) => item.id === req.params.id);

  if (!job || !canViewJob(req.user, job)) {
    return res.status(404).json({ error: '参考图不存在。' });
  }

  const reference = normalizeInputImages(job.inputImages, job.inputImage).find((image) => image.id === req.params.refId);
  if (!reference?.dataUrl) {
    return res.status(404).json({ error: '参考图不存在。' });
  }

  sendDataImage(res, reference.dataUrl);
});

app.delete('/api/jobs/:id', requireAuth, (req, res) => {
  const jobIndex = store.jobs.findIndex((item) => item.id === req.params.id);
  const job = store.jobs[jobIndex];

  if (!job || !canViewJob(req.user, job)) {
    return res.status(404).json({ error: '任务不存在。' });
  }

  if (req.user.role === 'admin') {
    store.jobs.splice(jobIndex, 1);
    saveStore();
    return res.json({ deleted: true, mode: 'removed' });
  }

  job.hiddenForUserIds = Array.from(new Set([...(job.hiddenForUserIds || []), req.user.id]));
  job.updatedAt = new Date().toISOString();
  saveStore();

  res.json({ deleted: true, mode: 'hidden' });
});

// dist/ 已随仓库提交，正常情况下容器直接使用现成的构建产物。
// 仅当 dist 完全缺失时才尝试兜底构建（注意：部分容器 Node 版本偏低，
// vite build 可能失败——此时请在本地构建后提交 dist/，不要依赖容器构建）。
if (!existsSync(distDir) && process.env.SKIP_AUTO_BUILD !== '1') {
  try {
    console.log('dist/ 缺失，尝试兜底构建（vite build）…若失败请在本地构建后提交 dist/。');
    execSync('npm run build', {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' }
    });
    console.log('前端构建完成。');
  } catch (error) {
    console.error('前端兜底构建失败，将只提供 API（请在本地构建后提交 dist/）：', error?.message || error);
  }
}

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(join(distDir, 'index.html'));
  });
}

app.post('/api/jobs', requireAuth, (req, res) => {
  const result = createJob(req.user, req.body ?? {});

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.status(202).json({ job: publicJob(result.job, req.user) });
});

app.post('/api/generate', requireAuth, (req, res) => {
  const result = createJob(req.user, req.body ?? {});

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.status(202).json({ job: publicJob(result.job, req.user) });
});

function createJob(user, payload) {
  pruneExpiredJobs();

  const { prompt, providerId, ratio, style, inputImage } = payload;
  const inputImages = normalizeInputImages(payload.inputImages, inputImage);
  const requestedType = payload.generationType === 'image-to-image' ? 'image-to-image' : 'text-to-image';
  const method = normalizeGenerationMethod(payload.method);
  const size = String(payload.size || ratio || 'auto');

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 4) {
    return { error: '请输入至少 4 个字符的提示词。' };
  }

  const provider = providers.find((item) => item.id === providerId) || providers[0];
  const generationType = requestedType;

  if (!provider) {
    return { error: '当前没有可用模型配置。' };
  }

  if (generationType === 'text-to-image' && !provider.supportsTextToImage) {
    return { error: '当前模型暂未启用文生图。' };
  }

  if (generationType === 'text-to-image' && method === 'responses' && !provider.supportsResponses) {
    return { error: '当前模型暂未启用 Responses 生图。' };
  }

  if (generationType === 'text-to-image' && method === 'chat' && !provider.supportsChatCompletions) {
    return { error: '当前模型暂未启用 Chat 生图。' };
  }

  if (generationType === 'image-to-image' && !provider.supportsImageToImage) {
    return { error: '当前模型暂未启用图生图。' };
  }

  if (generationType === 'image-to-image' && !inputImages.length) {
    return { error: '请选择参考图后再生成图生图。' };
  }

  if (inputImages.some((image) => String(image.dataUrl || image).length > maxInputImageLength)) {
    return { error: '参考图仍然过大，请压缩后再上传。' };
  }

  const totalInputImageBytes = inputImages.reduce((total, image) => total + dataUrlToApproxBytes(image.dataUrl), 0);
  if (totalInputImageBytes > maxInputImagesTotalBytes) {
    return { error: `参考图总大小不能超过 ${formatBytes(maxInputImagesTotalBytes)}，请删除部分参考图后再提交。` };
  }

  if (inputImages.length > 16) {
    return { error: '最多上传 16 张参考图。' };
  }

  const job = {
    id: randomUUID(),
    userId: user.id,
    username: user.username,
    prompt: prompt.trim().slice(0, 600),
    providerId: provider.id,
    providerName: provider.name,
    generationType,
    method: generationType === 'image-to-image' ? 'edits' : method,
    ratio: ratio || '1:1',
    size,
    style: style || '',
    inputImages: generationType === 'image-to-image' ? inputImages : [],
    inputImage: generationType === 'image-to-image' ? inputImages[0]?.dataUrl || '' : '',
    imageUrl: '',
    status: 'queued',
    progress: 4,
    progressMessage: '任务已创建，等待开始生成',
    error: '',
    warning: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: ''
  };

  store.jobs.push(job);
  saveStore();
  startGeneration(job.id);

  return { job };
}

function loadStore() {
  mkdirSync(dataDir, { recursive: true });

  if (!existsSync(storePath)) {
    const initialStore = {
      users: [
        {
          id: 'admin',
          username: 'admin',
          password: defaultAdminPassword,
          role: 'admin',
          createdAt: new Date().toISOString()
        }
      ],
      jobs: [],
      settings: {}
    };
    writeFileSync(storePath, JSON.stringify(initialStore, null, 2));
    return initialStore;
  }

  const existingStore = JSON.parse(readFileSync(storePath, 'utf8'));
  const admin = existingStore.users?.find((user) => user.username === 'admin');
  if (admin && admin.password.length < 6) {
    admin.password = defaultAdminPassword;
    admin.passwordMigratedAt = new Date().toISOString();
    writeFileSync(storePath, JSON.stringify(existingStore, null, 2));
  }
  return existingStore;
}

function loadModelConfig() {
  if (!existsSync(modelConfigPath)) {
    return [];
  }

  const config = JSON.parse(readFileSync(modelConfigPath, 'utf8'));
  return (config.models || []).filter((model) => model.id && model.name && model.defaultBaseUrl);
}

function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    provider: provider.provider,
    modeLabel: provider.modeLabel,
    supportsTextToImage: Boolean(provider.supportsTextToImage),
    supportsImageToImage: Boolean(provider.supportsImageToImage),
    supportsResponses: Boolean(provider.supportsResponses),
    supportsChatCompletions: Boolean(provider.supportsChatCompletions),
    defaultBaseUrl: provider.defaultBaseUrl,
    defaultGenerationModel: provider.defaultGenerationModel,
    defaultEditModel: provider.defaultEditModel,
    defaultResponsesModel: provider.defaultResponsesModel,
    defaultChatModel: provider.defaultChatModel
  };
}

function saveStore() {
  writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function pruneExpiredJobs() {
  const cutoff = Date.now() - historyRetentionMs;
  const initialCount = store.jobs.length;
  store.jobs = store.jobs.filter((job) => {
    if (job.status === 'queued' || job.status === 'running') return true;
    const dateValue = job.completedAt || job.createdAt;
    const timestamp = Date.parse(dateValue || '');
    if (!Number.isFinite(timestamp)) return true;
    return timestamp >= cutoff;
  });

  if (store.jobs.length !== initialCount) {
    saveStore();
  }
}

function normalizeCredentials(payload) {
  return {
    username: stripSpaces(payload.username),
    password: stripSpaces(payload.password)
  };
}

function normalizeInputImages(inputImages, legacyInputImage) {
  const source = Array.isArray(inputImages) ? inputImages : legacyInputImage ? [{ dataUrl: legacyInputImage }] : [];
  return source.slice(0, 16).map((image, index) => {
    if (typeof image === 'string') return { id: randomUUID(), dataUrl: image, name: `参考图 ${index + 1}` };
    return {
      id: String(image.id || randomUUID()),
      dataUrl: String(image.dataUrl || ''),
      name: String(image.name || `参考图 ${index + 1}`),
      width: Number(image.width || 0),
      height: Number(image.height || 0),
      bytes: Number(image.bytes || 0)
    };
  }).filter((image) => image.dataUrl);
}

function stripSpaces(value) {
  return String(value || '').replace(/\s+/g, '');
}

function validateCredentials({ username, password }, { allowAdmin }) {
  if (!username) return '请输入账号。';
  if (!/^[A-Za-z]+$/.test(username)) return '账号只能使用英文字母，不能包含数字、符号或空格。';
  if (username.length < 5) return '账号最少 5 位。';
  if (username.length > 15) return '账号最长 15 位。';
  if (!allowAdmin && username === 'admin') return '账号不能注册为 admin。';
  if (allowAdmin && username === 'admin') return validateAdminLoginPassword(password);
  return validatePassword(password);
}

function validateAdminLoginPassword(password) {
  if (!password) return '请输入密码。';
  if (!/^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(password)) return '密码只能使用英文、数字和常见特殊符号。';
  if (password.length > 20) return '密码最长 20 位。';
  return '';
}

function validatePassword(password) {
  if (!password) return '请输入密码。';
  if (!/^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(password)) return '密码只能使用英文、数字和常见特殊符号。';
  if (password.length < 6) return '密码最少 6 位。';
  if (password.length > 20) return '密码最长 20 位。';
  return '';
}

function createUser(username, password) {
  const user = {
    id: randomUUID(),
    username,
    password,
    role: username === 'admin' ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
    settings: {}
  };
  store.users.push(user);
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}

function settingsForUser(user) {
  return {
    ...environmentDefaultSettings(),
    ...adminDefaultSettings(),
    ...filledSettings(user.settings || {})
  };
}

function userOwnSettings(user) {
  return {
    ...(user.settings || {})
  };
}

function filledSettings(settings) {
  return Object.fromEntries(
    Object.entries(settings || {}).filter(([, value]) => String(value || '').trim() !== '')
  );
}

function adminDefaultSettings() {
  return {
    ...(store.settings || {})
  };
}

function environmentDefaultSettings() {
  return {
    baseUrl: process.env.DEFAULT_GPT_BASE_URL || '',
    apiKey: process.env.DEFAULT_GPT_API_KEY || '',
    generationModel: process.env.DEFAULT_GPT_IMAGE_MODEL || '',
    editModel: process.env.DEFAULT_GPT_EDIT_MODEL || '',
    responsesModel: process.env.DEFAULT_GPT_RESPONSES_MODEL || '',
    chatModel: process.env.DEFAULT_GPT_CHAT_MODEL || '',
    grokBaseUrl: process.env.DEFAULT_GROK_BASE_URL || '',
    grokApiKey: process.env.DEFAULT_GROK_API_KEY || '',
    grokModel: process.env.DEFAULT_GROK_IMAGE_MODEL || ''
  };
}

function publicSettings(settings) {
  return {
    ...settings,
    apiKey: maskSecret(settings.apiKey),
    grokApiKey: maskSecret(settings.grokApiKey)
  };
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '********';
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function isMaskedSecret(value) {
  return /^.{0,8}\*{4,}.*/.test(String(value || ''));
}

function normalizeUserSettings(payload) {
  const current = typeof payload === 'object' && payload ? payload : {};
  const normalized = {};

  for (const key of ['baseUrl', 'apiKey', 'generationModel', 'editModel', 'responsesModel', 'chatModel', 'grokBaseUrl', 'grokApiKey', 'grokModel']) {
    if (Object.hasOwn(current, key)) {
      normalized[key] = String(current[key] || '').trim();
    }
  }

  return normalized;
}

function mergeDraftSettings(baseSettings, draft) {
  const normalized = normalizeUserSettings(draft);
  if (isMaskedSecret(normalized.apiKey)) normalized.apiKey = baseSettings.apiKey;
  if (isMaskedSecret(normalized.grokApiKey)) normalized.grokApiKey = baseSettings.grokApiKey;
  return {
    ...baseSettings,
    ...normalized
  };
}

function validateUserSettings(settings) {
  for (const key of ['baseUrl', 'grokBaseUrl']) {
    if (settings[key] && !/^https?:\/\//.test(settings[key])) {
      return '接口地址必须以 http:// 或 https:// 开头。';
    }
  }

  return '';
}

function normalizeGenerationMethod(value) {
  if (value === 'auto') return 'auto';
  if (value === 'responses') return 'responses';
  if (value === 'chat') return 'chat';
  return 'generations';
}

function resolvedValue(userValue, providerDefault, envValue) {
  return String(userValue || providerDefault || envValue || '').trim();
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, username: user.username })).toString('base64url');
  const signature = createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;

  const expected = createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  if (signature !== expected) return null;

  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return store.users.find((user) => user.id === parsed.id) || null;
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  const user = verifyToken(token);

  if (!user) {
    return res.status(401).json({ error: '请先登录。' });
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '只有管理员可以修改默认模型配置。' });
  }

  next();
}

function sendJobEvent(res, job, user = { role: 'user', id: job.userId }) {
  res.write(`data: ${JSON.stringify(publicJob(job, user))}\n\n`);
}

function notifyJob(job) {
  const subscribers = jobSubscribers.get(job.id);
  if (!subscribers) return;

  for (const res of subscribers) {
    sendJobEvent(res, job);
  }

  if (job.status === 'completed' || job.status === 'failed') {
    for (const res of subscribers) {
      res.end();
    }
    jobSubscribers.delete(job.id);
  }
}

function visibleJobs(user) {
  if (user.role === 'admin') return store.jobs;
  return store.jobs.filter((job) => job.userId === user.id && !job.hiddenForUserIds?.includes(user.id));
}

function canViewJob(user, job) {
  return user.role === 'admin' || job.userId === user.id;
}

function publicJob(job, user) {
  const includeOwner = user.role === 'admin';

  return {
    id: job.id,
    prompt: job.prompt,
    providerId: job.providerId,
    providerName: job.providerName,
    generationType: job.generationType,
    method: job.method || 'generations',
    ratio: job.ratio,
    size: job.size || job.ratio,
    style: job.style,
    warning: job.warning || '',
    imageUrl: job.imageUrl ? `/api/jobs/${job.id}/image` : '',
    inputImages: job.generationType === 'image-to-image' ? normalizeInputImages(job.inputImages, job.inputImage).map((image) => ({
      id: image.id,
      dataUrl: `/api/jobs/${job.id}/references/${image.id}`,
      name: image.name,
      width: image.width,
      height: image.height
    })) : [],
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    username: includeOwner ? job.username : ''
  };
}

function resumeRunningJobs() {
  for (const job of store.jobs) {
    if (job.status === 'queued' || job.status === 'running') {
      startGeneration(job.id);
    }
  }
}

function startGeneration(jobId) {
  if (runningJobs.has(jobId)) return;

  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) return;

  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  saveStore();
  notifyJob(job);

  let stepIndex = 0;
  const timer = setInterval(async () => {
    const current = store.jobs.find((item) => item.id === jobId);

    if (!current || current.status !== 'running') {
      clearInterval(timer);
      runningJobs.delete(jobId);
      return;
    }

    const step = progressSteps[stepIndex];
    if (step) {
      current.progress = step.progress;
      current.progressMessage = step.message;
      current.updatedAt = new Date().toISOString();
      saveStore();
      notifyJob(current);
      stepIndex += 1;
      return;
    }

    clearInterval(timer);
    runningJobs.delete(jobId);

    try {
      const result = await generateImage(current);
      const imageUrl = typeof result === 'string' ? result : result.imageUrl;
      current.imageUrl = imageUrl;
      current.warning = typeof result === 'object' ? result.warning || '' : current.warning || '';
      current.status = 'completed';
      current.progress = 100;
      current.progressMessage = '图片生成完成';
      current.completedAt = new Date().toISOString();
      current.updatedAt = new Date().toISOString();
      pruneExpiredJobs();
      saveStore();
      notifyJob(current);
    } catch (error) {
      current.status = 'failed';
      current.progressMessage = '生成失败';
      current.error = error.message;
      current.updatedAt = new Date().toISOString();
      saveStore();
      notifyJob(current);
    }
  }, 1100);

  runningJobs.set(jobId, timer);
}

async function generateImage(job) {
  const provider = providers.find((item) => item.id === job.providerId);
  const user = store.users.find((item) => item.id === job.userId);
  if (provider?.provider === 'openai') return generateOpenAiImage(job, provider, settingsForUser(user || {}));
  if (provider?.provider === 'xai') return generateXaiImage(job, provider, settingsForUser(user || {}));

  return createGeneratedSvg(job);
}

async function generateOpenAiImage(job, provider, settings) {
  const apiKey = resolvedValue(settings.apiKey, '', process.env[provider.apiKeyEnv]);

  if (!apiKey) throw new Error('当前没有可用的 GPT API Key，请在接口配置中填写，或通知管理员配置默认 Key。');

  if (job.generationType === 'image-to-image') {
    return generateOpenAiImageEdit(job, provider, settings, apiKey);
  }

  const method = resolveOpenAiTextMethod(job, provider, settings);

  if (method === 'responses') {
    return generateOpenAiResponsesImage(job, provider, settings, apiKey);
  }

  if (method === 'chat') {
    return generateOpenAiChatImage(job, provider, settings, apiKey);
  }

  const payload = {
    model: resolvedValue(settings.generationModel, provider.defaultGenerationModel, process.env.DEFAULT_GPT_IMAGE_MODEL),
    prompt: job.prompt,
    size: sizeForJob(job),
    response_format: provider.responseFormat || 'b64_json'
  };

  for (const [key, value] of Object.entries(provider.extraPayload || {})) {
    payload[key] = value;
  }

  assertModel(payload.model, 'Images 模型');

  const endpoint = routeFromBaseUrl(resolvedValue(settings.baseUrl, provider.defaultBaseUrl, process.env.DEFAULT_GPT_BASE_URL), '/v1/images/generations');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    return retryWithoutSizeIfNeeded({
      responseData: data,
      provider,
      endpoint,
      apiKey,
      payload,
      errorMessage: data.error?.message || `${provider.name} 图片生成失败。`
    });
  }

  return extractImageUrl(data);
}

async function generateOpenAiImageEdit(job, provider, settings, apiKey) {
  const inputImages = normalizeInputImages(job.inputImages, job.inputImage);
  const formData = new FormData();
  const model = resolvedValue(settings.editModel, provider.defaultEditModel || settings.generationModel || provider.defaultGenerationModel, process.env.DEFAULT_GPT_EDIT_MODEL);

  assertModel(model, 'Edits 模型');
  formData.append('model', model);
  formData.append('prompt', job.prompt);
  formData.append('size', sizeForJob(job));
  formData.append('response_format', provider.responseFormat || 'b64_json');
  inputImages.forEach((image, index) => {
    const imageFile = dataUrlToFile(image.dataUrl, image.name || `reference-${index + 1}.jpg`);
    formData.append('image[]', imageFile.blob, imageFile.filename);
  });

  for (const [key, value] of Object.entries(provider.extraPayload || {})) {
    formData.append(key, value);
  }

  const response = await fetch(routeFromBaseUrl(resolvedValue(settings.baseUrl, provider.defaultBaseUrl, process.env.DEFAULT_GPT_BASE_URL), '/v1/images/edits'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || `${provider.name} 图片编辑失败。`;
    if (isSizeError(message)) {
      formData.set('size', 'auto');
      const retryResponse = await fetch(routeFromBaseUrl(resolvedValue(settings.baseUrl, provider.defaultBaseUrl, process.env.DEFAULT_GPT_BASE_URL), '/v1/images/edits'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData
      });
      const retryData = await retryResponse.json();
      if (!retryResponse.ok) throw new Error(retryData.error?.message || message);
      return {
        imageUrl: extractImageUrl(retryData),
        warning: '所选分辨率当前接口不支持，已自动使用默认分辨率生成。'
      };
    }
    throw new Error(message);
  }

  return extractImageUrl(data);
}

async function generateOpenAiResponsesImage(job, provider, settings, apiKey) {
  const model = resolvedValue(settings.responsesModel, provider.defaultResponsesModel, process.env.DEFAULT_GPT_RESPONSES_MODEL);
  assertModel(model, 'Responses 模型');

  const payload = {
    model,
    input: job.prompt,
    tools: [
      {
        type: 'image_generation',
        size: sizeForJob(job),
        quality: 'auto',
        background: 'auto',
        output_format: 'png',
        moderation: 'low'
      }
    ],
    tool_choice: {
      type: 'image_generation'
    }
  };

  const endpoint = routeFromBaseUrl(resolvedValue(settings.baseUrl, provider.defaultBaseUrl, process.env.DEFAULT_GPT_BASE_URL), '/v1/responses');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    return retryToolWithoutSizeIfNeeded({
      responseData: data,
      provider,
      endpoint,
      apiKey,
      payload,
      errorMessage: data.error?.message || `${provider.name} Responses 生图失败。`
    });
  }

  return extractImageUrl(data);
}

async function generateOpenAiChatImage(job, provider, settings, apiKey) {
  const model = resolvedValue(settings.chatModel, provider.defaultChatModel, process.env.DEFAULT_GPT_CHAT_MODEL);
  assertModel(model, 'Chat 模型');

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: job.prompt
      }
    ],
    tools: [
      {
        type: 'image_generation',
        size: sizeForJob(job),
        quality: 'auto',
        background: 'auto',
        output_format: 'png'
      }
    ],
    tool_choice: {
      type: 'image_generation'
    }
  };

  const endpoint = routeFromBaseUrl(resolvedValue(settings.baseUrl, provider.defaultBaseUrl, process.env.DEFAULT_GPT_BASE_URL), '/v1/chat/completions');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    return retryToolWithoutSizeIfNeeded({
      responseData: data,
      provider,
      endpoint,
      apiKey,
      payload,
      errorMessage: data.error?.message || `${provider.name} Chat 生图失败。`
    });
  }

  return extractImageUrl(data);
}

async function generateXaiImage(job, provider, settings) {
  const apiKey = resolvedValue(settings.grokApiKey, '', process.env[provider.apiKeyEnv]);

  if (!apiKey) throw new Error('当前没有可用的 Grok API Key，请在接口配置中填写，或通知管理员配置默认 Key。');

  if (job.generationType === 'image-to-image') {
    throw new Error('Grok 官方图片接口当前仅启用文生图。');
  }

  const model = resolvedValue(settings.grokModel, provider.defaultGenerationModel, process.env.DEFAULT_GROK_IMAGE_MODEL);
  assertModel(model, 'Grok 模型');

  const payload = {
    model,
    prompt: job.prompt,
    ...xaiImageSizeParams(job),
    response_format: provider.responseFormat || 'b64_json'
  };

  for (const [key, value] of Object.entries(provider.extraPayload || {})) {
    payload[key] = value;
  }

  const endpoint = routeFromBaseUrl(resolvedValue(settings.grokBaseUrl, provider.defaultBaseUrl, process.env.DEFAULT_GROK_BASE_URL), '/v1/images/generations');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await response.text();
  const data = parseJsonBody(bodyText);
  if (!response.ok) {
    if (response.status >= 500) {
      return retryXaiWithMinimalPayload({ endpoint, apiKey, payload, provider, response, data });
    }
    throw new Error(formatProviderError(provider.name, response, data, bodyText));
  }

  return extractImageUrl(data);
}

async function retryXaiWithMinimalPayload({ endpoint, apiKey, payload, provider, response, data }) {
  const retryPayload = {
    model: payload.model,
    prompt: payload.prompt,
    aspect_ratio: 'auto',
    response_format: payload.response_format || provider.responseFormat || 'b64_json'
  };

  const retryResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(retryPayload)
  });
  const retryText = await retryResponse.text();
  const retryData = parseJsonBody(retryText);

  if (!retryResponse.ok) {
    throw new Error(formatProviderError(provider.name, retryResponse, retryData, retryText, data?.error?.message || response.statusText));
  }

  return {
    imageUrl: extractImageUrl(retryData),
    warning: 'Grok 接口对当前参数返回服务端错误，已自动使用默认比例重试生成。'
  };
}

function formatProviderError(providerName, response, data, bodyText, fallback = '') {
  const upstreamMessage = data?.error?.message || data?.message || fallback || bodyText?.slice(0, 180) || `${providerName} 图片生成失败。`;
  if (response.status >= 500) return `${providerName} 上游服务暂时异常（HTTP ${response.status}）：${upstreamMessage}`;
  if (response.status === 401 || response.status === 403) return `${providerName} API Key 无效或权限不足。`;
  if (response.status === 404) return `${providerName} 图片接口地址无效，请检查 Base URL。`;
  return `${providerName} 图片生成失败（HTTP ${response.status}）：${upstreamMessage}`;
}

function extractImageUrl(data) {
  const found = findImageInResponse(data);
  if (found) return found;
  throw new Error('模型返回中未找到图片。');
}

function findImageInResponse(value, seen = new WeakSet()) {
  if (value == null) return '';

  if (typeof value === 'string') {
    const text = value.trim().replace(/\\\//g, '/');
    const markdownMatch = /!\[[^\]]*]\(\s*<?((?:https?:\/\/|data:image\/)[^)\s>]+)>?/i.exec(text);
    if (markdownMatch) return markdownMatch[1];
    if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('data:image/')) return text;
    if (looksLikeBase64Image(text)) return `data:image/png;base64,${text.replace(/\s/g, '')}`;
    return '';
  }

  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageInResponse(item, seen);
      if (found) return found;
    }
    return '';
  }

  for (const key of ['b64_json', 'image_base64', 'base64', 'result']) {
    if (typeof value[key] === 'string' && looksLikeBase64Image(value[key])) {
      return value[key].startsWith('data:image/') ? value[key] : `data:image/png;base64,${value[key].replace(/\s/g, '')}`;
    }
  }

  for (const key of ['url', 'image_url', 'output_url']) {
    if (typeof value[key] === 'string') {
      const found = findImageInResponse(value[key], seen);
      if (found) return found;
    }
  }

  for (const child of Object.values(value)) {
    const found = findImageInResponse(child, seen);
    if (found) return found;
  }

  return '';
}

function looksLikeBase64Image(value) {
  const text = String(value || '').trim();
  if (text.startsWith('data:image/')) return true;
  return text.length > 80 && /^[A-Za-z0-9+/=\s]+$/.test(text);
}

function routeFromBaseUrl(baseUrl, route) {
  const input = String(baseUrl || '').trim().replace(/\/+$/, '');
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
  const routeWithoutV1 = normalizedRoute.replace(/^\/v1\//, '/');

  if (input.endsWith(normalizedRoute) || input.endsWith(routeWithoutV1)) return input;
  if (input.endsWith('/v1')) return `${input}${routeWithoutV1}`;
  return `${input}/v1${routeWithoutV1}`;
}

function resolveOpenAiTextMethod(job, provider, settings) {
  if (job.method && job.method !== 'auto') return job.method;
  if (resolvedValue(settings.generationModel, provider.defaultGenerationModel, process.env.DEFAULT_GPT_IMAGE_MODEL)) return 'generations';
  if (resolvedValue(settings.responsesModel, provider.defaultResponsesModel, process.env.DEFAULT_GPT_RESPONSES_MODEL)) return 'responses';
  if (resolvedValue(settings.chatModel, provider.defaultChatModel, process.env.DEFAULT_GPT_CHAT_MODEL)) return 'chat';
  throw new Error('当前没有可用的 GPT 生图模型，请在接口配置中填写模型，或通知管理员配置默认模型。');
}

function assertModel(model, label) {
  if (!model) throw new Error(`${label}不能为空，请在接口配置中填写模型，或通知管理员配置默认模型。`);
}

function isSizeError(message) {
  return /size|resolution|dimensions|分辨率|尺寸/i.test(String(message || ''));
}

async function retryWithoutSizeIfNeeded({ responseData, provider, endpoint, apiKey, payload, errorMessage }) {
  if (!isSizeError(errorMessage)) throw new Error(errorMessage);

  const retryPayload = { ...payload, size: 'auto' };
  const retryResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(retryPayload)
  });
  const retryData = await retryResponse.json();
  if (!retryResponse.ok) throw new Error(retryData.error?.message || responseData.error?.message || `${provider.name} 图片生成失败。`);

  return {
    imageUrl: extractImageUrl(retryData),
    warning: '所选分辨率当前接口不支持，已自动使用默认分辨率生成。'
  };
}

async function retryToolWithoutSizeIfNeeded({ responseData, provider, endpoint, apiKey, payload, errorMessage }) {
  if (!isSizeError(errorMessage)) throw new Error(errorMessage);

  const retryPayload = {
    ...payload,
    tools: payload.tools?.map((tool) => ({ ...tool, size: 'auto' })) || []
  };
  const retryResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(retryPayload)
  });
  const retryData = await retryResponse.json();
  if (!retryResponse.ok) throw new Error(retryData.error?.message || responseData.error?.message || `${provider.name} 图片生成失败。`);

  return {
    imageUrl: extractImageUrl(retryData),
    warning: '所选分辨率当前接口不支持，已自动使用默认分辨率生成。'
  };
}

function dataUrlToFile(dataUrl, filename) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error('参考图格式无效。');

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  return {
    filename,
    blob: new Blob([buffer], { type: mimeType })
  };
}

function sendDataImage(res, dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return res.status(404).json({ error: '图片不存在。' });

  const buffer = Buffer.from(match[2], 'base64');
  res.setHeader('Content-Type', match[1]);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buffer);
}

function dataUrlToApproxBytes(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function sizeForJob(job) {
  if (job.size && job.size !== 'auto') return job.size;
  return sizeForRatio(job.ratio);
}

function xaiImageSizeParams(job) {
  const size = String(job.size || job.ratio || 'auto');

  if (size === 'auto') {
    return { aspect_ratio: 'auto' };
  }

  const [width, height] = size.split('x').map((item) => Number.parseInt(item, 10));
  if (!width || !height) {
    return { aspect_ratio: 'auto' };
  }

  const resolution = Math.max(width, height) >= 1800 ? '2k' : '1k';
  const aspectRatio = reduceAspectRatio(width, height);

  return {
    aspect_ratio: aspectRatio,
    resolution
  };
}

function reduceAspectRatio(width, height) {
  const divisor = greatestCommonDivisor(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  const supported = new Set(['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1']);

  if (supported.has(ratio)) return ratio;
  if (width === height) return '1:1';
  return width > height ? '16:9' : '9:16';
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);

  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a || 1;
}

function sizeForRatio(ratio) {
  if (ratio === '16:9') return '1536x864';
  if (ratio === '9:16') return '864x1536';
  if (ratio === '4:3') return '1280x960';
  return '1024x1024';
}

function createGeneratedSvg({ prompt, providerName, generationType, style, ratio }) {
  const [width, height] = dimensionsForRatio(ratio);
  const escapedPrompt = escapeHtml(prompt);
  const escapedStyle = escapeHtml(`${providerName} · ${generationType} · ${style}`);
  const color = providerName?.includes('Grok') ? '#111827' : '#2563eb';
  const secondary = providerName?.includes('Grok') ? '#22c55e' : '#7c3aed';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f8fafc"/>
          <stop offset="48%" stop-color="${color}"/>
          <stop offset="100%" stop-color="${secondary}"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="38%" r="52%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.72"/>
          <stop offset="55%" stop-color="#ffffff" stop-opacity="0.16"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
        <filter id="blur">
          <feGaussianBlur stdDeviation="18"/>
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <circle cx="${width * 0.78}" cy="${height * 0.24}" r="${Math.min(width, height) * 0.24}" fill="url(#glow)"/>
      <circle cx="${width * 0.18}" cy="${height * 0.78}" r="${Math.min(width, height) * 0.18}" fill="#fff" opacity="0.18" filter="url(#blur)"/>
      <path d="M ${width * 0.08} ${height * 0.68} C ${width * 0.26} ${height * 0.48}, ${width * 0.42} ${height * 0.88}, ${width * 0.62} ${height * 0.64} S ${width * 0.88} ${height * 0.46}, ${width * 0.96} ${height * 0.58}" fill="none" stroke="#fff" stroke-width="6" opacity="0.34"/>
      <g transform="translate(${width * 0.08}, ${height * 0.1})">
        <rect width="${width * 0.84}" height="${height * 0.8}" rx="34" fill="#ffffff" opacity="0.82" stroke="#ffffff" stroke-opacity="0.5"/>
        <text x="36" y="64" fill="#0f172a" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="3">IMAGE STUDIO</text>
        <text x="36" y="112" fill="#475569" font-family="Inter, Arial, sans-serif" font-size="18">${escapedStyle}</text>
        <foreignObject x="36" y="150" width="${width * 0.72}" height="${height * 0.42}">
          <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Inter, Arial, sans-serif; color: #0f172a; font-size: 34px; line-height: 1.15; font-weight: 800; word-break: break-word;">${escapedPrompt}</div>
        </foreignObject>
      </g>
    </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function dimensionsForRatio(ratio) {
  if (ratio === '16:9') return [1280, 720];
  if (ratio === '9:16') return [720, 1280];
  if (ratio === '4:3') return [1200, 900];
  return [1024, 1024];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// 始终绑 0.0.0.0（涵盖 127.0.0.1），不要用面板注入的外网 SERVER_IP，
// 否则 cloudflared 从容器内用 localhost 连不上（connection refused）。
const host = '0.0.0.0';
app.listen(port, host, () => {
  console.log(`Image Studio API running on http://${host}:${port}`);
  startTunnel(port);
});
