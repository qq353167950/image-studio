import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import './styles.css';

const sizeOptions = [
  { value: 'auto', label: '自动' },
  { value: '1024x1024', label: '1024x1024（1K 方图）' },
  { value: '1536x1024', label: '1536x1024（横图）' },
  { value: '1024x1536', label: '1024x1536（竖图）' },
  { value: '2048x2048', label: '2048x2048（2K 方图）' },
  { value: '2048x1152', label: '2048x1152（2K 横图）' },
  { value: '1152x2048', label: '1152x2048（2K 竖图）' }
];
const methods = [
  { value: 'auto', label: '自动' },
  { value: 'generations', label: 'Images' },
  { value: 'responses', label: 'Responses' },
  { value: 'chat', label: 'Chat' }
];
const maxReferenceImages = 16;
const maxReferenceTotalBytes = 8 * 1024 * 1024;

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('image-studio-token') || '');
  const [user, setUser] = useState(null);
  const [models, setModels] = useState([]);
  const [view, setView] = useState('studio');
  const [currentBatch, setCurrentBatch] = useState(null);
  const [submittingJob, setSubmittingJob] = useState(false);
  const [lightboxJob, setLightboxJob] = useState(null);
  const [toast, setToast] = useState('');
  const [referenceInfo, setReferenceInfo] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [settings, setSettings] = useState(defaultSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('gpt');
  const [settingsMode, setSettingsMode] = useState('user');
  const [providerMethods, setProviderMethods] = useState({ gpt: 'generations', grok: 'generations' });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const [usersOpen, setUsersOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [showAllPasswords, setShowAllPasswords] = useState(false);
  const [availableModels, setAvailableModels] = useState({ gpt: [], grok: [] });
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [downloadingIds, setDownloadingIds] = useState([]);
  const touchActivationAtRef = useRef(0);
  const [form, setForm] = useState({
    prompt: '',
    providerId: 'gpt',
    generationType: 'text-to-image',
    method: 'generations',
    ratio: '1:1',
    size: 'auto',
    imageCount: 1,
    inputImages: []
  });

  const previewBatch = currentBatch;
  const generating = submittingJob || Boolean(currentBatch?.some((job) => job.status === 'queued' || job.status === 'running'));
  const referenceSummary = form.inputImages.length
    ? `已添加 ${form.inputImages.length} 张参考图，最多 ${maxReferenceImages} 张；总大小上限 ${formatBytes(maxReferenceTotalBytes)}，当前约 ${formatBytes(form.inputImages.reduce((total, image) => total + Number(image.bytes || dataUrlToBytes(image.dataUrl)), 0))}。`
    : '';

  useEffect(() => {
    if (shouldInstallClientDiagnostics()) installClientDiagnostics();
    api('/api/models').then((data) => {
      setModels(data.providers || []);
      if (data.providers?.[0]) {
        setForm((current) => ({ ...current, providerId: current.providerId || data.providers[0].id }));
      }
    }).catch(() => setToast('模型列表加载失败'));
  }, []);

  useEffect(() => {
    if (!token) return;

    api('/api/me', { token })
      .then((data) => setUser(data.user))
      .catch(() => handleLogout());
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;

    api('/api/settings', { token })
      .then((data) => setSettings({ ...defaultSettings(), ...(data.settings || {}) }))
      .catch((error) => setToast(error.message));
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;

    let cancelled = false;

    async function loadActiveBatch() {
      try {
        const activeData = await api('/api/jobs/active', { token });
        if (cancelled) return;

        const activeGroups = groupJobsByBatch(activeData.jobs || []);
        if (activeGroups.length) {
          setCurrentBatch(activeGroups[0]);
        }
      } catch (error) {
        if (!cancelled) setToast(error.message);
      }
    }

    loadActiveBatch();

    return () => {
      cancelled = true;
    };
  }, [token, user]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const pendingIds = (currentBatch || []).filter((job) => job.status === 'queued' || job.status === 'running').map((job) => job.id);
    if (!token || !pendingIds.length) return;

    // 批量任务统一用轮询跟踪进度：多张图并行生成时比多路 SSE 更简单可靠。
    let cancelled = false;

    async function pollBatch() {
      try {
        const updates = await Promise.all(pendingIds.map((id) => api(`/api/jobs/${id}`, { token }).then((data) => data.job).catch(() => null)));
        if (cancelled) return;

        setCurrentBatch((current) => {
          if (!current) return current;
          return current.map((job) => {
            const updated = updates.find((item) => item?.id === job.id);
            return updated || job;
          });
        });
      } catch {
        // 单次轮询失败不打断跟踪，下一轮继续。
      }
    }

    const timer = setInterval(pollBatch, 1600);
    pollBatch();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, (currentBatch || []).map((job) => `${job.id}:${job.status}`).join('|')]);

  useEffect(() => {
    document.body.classList.toggle('modal-open', Boolean(lightboxJob || settingsOpen || passwordOpen || usersOpen));
    return () => document.body.classList.remove('modal-open');
  }, [lightboxJob, settingsOpen, passwordOpen, usersOpen]);

  function handleLogout() {
    localStorage.removeItem('image-studio-token');
    setToken('');
    setUser(null);
    setView('studio');
    setCurrentBatch(null);
    setUsersOpen(false);
    setAdminUsers([]);
  }

  async function handleLogin(event) {
    event.preventDefault();
    setToast('');

    const credentials = sanitizeAuthForm(loginForm);
    const validationError = validateAuthForm(credentials, { allowAdmin: authMode === 'login' });
    if (validationError) {
      setToast(validationError);
      return;
    }

    try {
      const data = await api(authMode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        body: credentials
      });
      localStorage.setItem('image-studio-token', data.token);
      setToken(data.token);
      setUser(data.user);
    } catch (error) {
      setToast(error.message);
    }
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setToast('');

    const validationError = validateGenerateForm(form, models);
    if (validationError) {
      setToast(validationError);
      return;
    }

    setSubmittingJob(true);
    const imageCount = Math.min(4, Math.max(1, Number(form.imageCount) || 1));
    const providerName = models.find((model) => model.id === form.providerId)?.name || (form.providerId === 'grok' ? 'Grok' : 'GPT');
    setCurrentBatch(createPendingBatch(form, imageCount, providerName));

    try {
      const data = await api('/api/jobs', {
        method: 'POST',
        token,
        body: { ...form, imageCount }
      });
      const created = data.jobs?.length ? data.jobs : [data.job].filter(Boolean);
      setCurrentBatch(created);
    } catch (error) {
      setCurrentBatch(null);
      setToast(error.message);
    } finally {
      setSubmittingJob(false);
    }
  }

  async function handleSaveSettings(event, tab = settingsTab) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setToast('');

    const validationError = validateSettingsForTab(settings, tab, { requireComplete: settingsMode === 'user' });
    if (validationError) {
      setToast(validationError);
      return;
    }

    try {
      const data = await api(settingsMode === 'admin' ? '/api/admin/settings' : '/api/settings', {
        method: 'PUT',
        token,
        body: settings
      });
      setSettings({ ...defaultSettings(), ...(data.settings || {}) });
      setToast(settingsMode === 'admin' ? '默认模型配置已保存' : '模型配置已保存');
      setSettingsOpen(false);
    } catch (error) {
      setToast(error.message);
    }
  }

  async function handleFetchModels(providerId = settingsTab, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const validationError = validateSettingsForTab(settings, providerId, { requireComplete: true, allowPartialModels: true });
    if (validationError) {
      setToast(validationError);
      return;
    }
    setToast('正在基于当前 URL 和 Key 获取模型列表...');

    try {
      const data = await api('/api/settings/models', {
        method: 'POST',
        token,
        body: { providerId, settings, mode: settingsMode }
      });
      setAvailableModels((current) => ({ ...current, [providerId]: data.models || [] }));
      setToast(data.models?.length ? '模型列表已获取，当前类型的模型输入框均可选择' : '接口未返回模型列表');
    } catch (error) {
      setToast(error.message);
    }
  }

  async function openUserSettings() {
    setSettingsMode('user');
    setPasswordOpen(false);
    setUsersOpen(false);
    setSettingsOpen(true);
    try {
      const data = await api('/api/settings', { token });
      setSettings({ ...defaultSettings(), ...(data.settings || {}) });
    } catch (error) {
      setToast(error.message);
    }
  }

  async function openAdminSettings() {
    setSettingsMode('admin');
    setPasswordOpen(false);
    setUsersOpen(false);
    setSettingsOpen(true);
    try {
      const data = await api('/api/admin/settings', { token });
      setSettings({ ...defaultSettings(), ...(data.settings || {}) });
    } catch (error) {
      setToast(error.message);
    }
  }

  async function openUsersPanel() {
    setSettingsOpen(false);
    setPasswordOpen(false);
    setShowAllPasswords(false);
    setUsersOpen(true);
    try {
      const data = await api('/api/admin/users', { token });
      setAdminUsers(data.users || []);
    } catch (error) {
      setToast(error.message);
    }
  }

  function runTopbarAction(action) {
    if (Date.now() - touchActivationAtRef.current < 700) return;
    action();
  }

  function runTopbarTouchAction(event, action) {
    event.preventDefault();
    event.stopPropagation();
    touchActivationAtRef.current = Date.now();
    action();
  }

  function openPasswordSettings() {
    setSettingsOpen(false);
    setUsersOpen(false);
    setPasswordOpen(true);
  }

  async function handleChangePassword(event) {
    event.preventDefault();
    setToast('');

    const validationError = validatePasswordChangeForm(passwordForm);
    if (validationError) {
      setToast(validationError);
      return;
    }

    try {
      const data = await api('/api/me/password', {
        method: 'PUT',
        token,
        body: passwordForm
      });
      // 服务端改密后旧 token 全部失效，用返回的新 token 续期当前设备。
      if (data.token) {
        localStorage.setItem('image-studio-token', data.token);
        setToken(data.token);
      }
      setPasswordForm({ currentPassword: '', newPassword: '' });
      setPasswordOpen(false);
      setToast('密码已修改，其他设备需要重新登录');
    } catch (error) {
      setToast(error.message);
    }
  }

  async function handleReferenceUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    setToast('正在压缩参考图...');

    try {
      const remaining = maxReferenceImages - form.inputImages.length;
      const selectedFiles = files.slice(0, Math.max(0, remaining));
      if (!selectedFiles.length) {
        setToast(`最多上传 ${maxReferenceImages} 张参考图。`);
        return;
      }

      const compressedImages = await Promise.all(selectedFiles.map(async (file) => {
        const compressed = await compressImage(file);
        return {
          id: createDiagnosticId(),
          dataUrl: compressed.dataUrl,
          bytes: compressed.bytes,
          width: compressed.width,
          height: compressed.height,
          name: file.name
        };
      }));

      const currentBytes = form.inputImages.reduce((total, image) => total + Number(image.bytes || dataUrlToBytes(image.dataUrl)), 0);
      const acceptedImages = [];
      let nextBytes = currentBytes;
      for (const image of compressedImages) {
        const imageBytes = Number(image.bytes || dataUrlToBytes(image.dataUrl));
        if (nextBytes + imageBytes > maxReferenceTotalBytes) break;
        acceptedImages.push(image);
        nextBytes += imageBytes;
      }

      if (!acceptedImages.length) {
        setToast(`参考图总大小最多 ${formatBytes(maxReferenceTotalBytes)}，请删除部分参考图后再上传。`);
        return;
      }

      setForm((current) => ({ ...current, inputImages: [...current.inputImages, ...acceptedImages].slice(0, maxReferenceImages), generationType: 'image-to-image' }));
      setReferenceInfo('');
      setToast(acceptedImages.length < compressedImages.length || files.length > selectedFiles.length ? `已添加 ${acceptedImages.length} 张，数量或总大小达到上限。` : '参考图已压缩并添加');
    } catch (error) {
      setToast(error.message);
    } finally {
      event.target.value = '';
    }
  }

  async function copyPrompt(prompt) {
    await navigator.clipboard.writeText(prompt);
    setToast('提示词已复制');
  }

  async function handleDownloadJobs(jobs) {
    const list = jobs.filter((job) => job?.status === 'completed' && job.imageUrl);
    if (!list.length) {
      setToast('当前没有可下载的图片');
      return;
    }

    const ids = list.map((job) => job.id);
    if (ids.some((id) => downloadingIds.includes(id))) return;

    setDownloadingIds((current) => Array.from(new Set([...current, ...ids])));
    setToast(list.length > 1 ? `正在打包下载 ${list.length} 张图片...` : '正在准备下载图片...');

    try {
      await downloadJobs(list, token);
      setToast(list.length > 1 ? '图片打包完成，已开始下载' : '图片已开始下载');
    } catch (error) {
      setToast(error.message || '下载失败，请稍后重试');
    } finally {
      setDownloadingIds((current) => current.filter((id) => !ids.includes(id)));
    }
  }

  function openHistory() {
    setSettingsOpen(false);
    setPasswordOpen(false);
    setUsersOpen(false);
    setView('history');
  }

  if (!user) {
    return (
      <main className="login-page">
        <section className="login-card">
          <div>
            <p className="kicker">AI Image Platform</p>
            <h1>{authMode === 'login' ? '登录' : '注册'}</h1>
            <p className="muted">账号 5-15 位，只能使用英文字母；密码 6-20 位，支持英文、数字和常见特殊符号。</p>
          </div>
          <form className="login-form" onSubmit={handleLogin}>
            <label>
              <span>账号</span>
              <input value={loginForm.username} maxLength="15" onChange={(event) => setLoginForm({ ...loginForm, username: sanitizeUsername(event.target.value) })} />
            </label>
            <label>
              <span>密码</span>
              <input type="password" value={loginForm.password} maxLength="20" onChange={(event) => setLoginForm({ ...loginForm, password: sanitizePassword(event.target.value) })} />
            </label>
            <button type="submit">{authMode === 'login' ? '进入工作台' : '注册并进入'}</button>
          </form>
          <button className="auth-switch" type="button" onClick={() => {
            setAuthMode(authMode === 'login' ? 'register' : 'login');
            setToast('');
          }}>
            {authMode === 'login' ? '没有账号，去注册' : '已有账号，去登录'}
          </button>
          {toast ? <p className="toast">{toast}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="kicker">AI Image Platform</p>
          <h1>智能图片生成平台</h1>
        </div>
        <div className="account-pill">
          <span>{user.role === 'admin' ? '管理员' : '用户'} · {user.username}</span>
          {view === 'history'
            ? <button type="button" onTouchEnd={(event) => runTopbarTouchAction(event, () => setView('studio'))} onClick={() => runTopbarAction(() => setView('studio'))}>返回工作台</button>
            : <button type="button" onTouchEnd={(event) => runTopbarTouchAction(event, openHistory)} onClick={() => runTopbarAction(openHistory)}>历史记录</button>}
          <button type="button" onTouchEnd={(event) => runTopbarTouchAction(event, openUserSettings)} onClick={() => runTopbarAction(openUserSettings)}>模型配置</button>
          {user.role === 'admin' ? <button type="button" onTouchEnd={(event) => runTopbarTouchAction(event, openAdminSettings)} onClick={() => runTopbarAction(openAdminSettings)}>默认模型配置</button> : null}
          {user.role === 'admin' ? <button type="button" onTouchEnd={(event) => runTopbarTouchAction(event, openUsersPanel)} onClick={() => runTopbarAction(openUsersPanel)}>用户管理</button> : null}
          <button type="button" onTouchEnd={(event) => runTopbarTouchAction(event, openPasswordSettings)} onClick={() => runTopbarAction(openPasswordSettings)}>修改密码</button>
          <button type="button" onClick={handleLogout}>退出</button>
        </div>
      </header>

      {settingsOpen ? createPortal((
        <SettingsDialog
          settings={settings}
          setSettings={setSettings}
          availableModels={availableModels}
          activeTab={settingsTab}
          setActiveTab={setSettingsTab}
          mode={settingsMode}
          onFetchModels={handleFetchModels}
          onSubmit={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      ), document.body) : null}

      {passwordOpen ? createPortal((
        <PasswordDialog
          form={passwordForm}
          setForm={setPasswordForm}
          onSubmit={handleChangePassword}
          onClose={() => setPasswordOpen(false)}
        />
      ), document.body) : null}

      {usersOpen ? createPortal((
        <UsersPanel
          users={adminUsers}
          showAll={showAllPasswords}
          onToggleAll={() => setShowAllPasswords((current) => !current)}
          onClose={() => setUsersOpen(false)}
        />
      ), document.body) : null}

      {view === 'history' ? (
        <HistoryPage
          user={user}
          token={token}
          onOpen={setLightboxJob}
          onCopy={copyPrompt}
          onToast={setToast}
          onDownload={handleDownloadJobs}
          downloadingIds={downloadingIds}
        />
      ) : (
      <section className="workspace">
        <form className="card composer" onSubmit={handleGenerate}>
          <ProviderTabs models={models} selectedId={form.providerId} onSelect={(providerId) => {
            const selected = models.find((model) => model.id === providerId);
            const rememberedMethod = providerMethods[providerId] || 'generations';
            setForm((current) => ({
              ...current,
              providerId,
              generationType: selected?.supportsImageToImage ? current.generationType : 'text-to-image',
              method: rememberedMethod,
              inputImages: selected?.supportsImageToImage ? current.inputImages : []
            }));
            if (!selected?.supportsImageToImage) setReferenceInfo('');
          }} />
          <div className="section-head">
            <h2>生成设置</h2>
            <span>{form.generationType === 'image-to-image' ? '图生图' : '文生图'}</span>
          </div>

          <GenerationTypePicker models={models} form={form} setForm={setForm} setReferenceInfo={setReferenceInfo} />
          <MethodPicker models={models} form={form} setForm={setForm} setProviderMethods={setProviderMethods} />

          <label className="field">
            <span>提示词</span>
            <textarea value={form.prompt} placeholder="描述你想生成的画面，例如主体、场景、风格、光线和构图。" rows="7" maxLength="600" onChange={(event) => setForm({ ...form, prompt: event.target.value })} />
          </label>

          <div className="form-grid">
            <label className="field">
              <span>分辨率</span>
              <select value={form.size} onChange={(event) => setForm({ ...form, size: event.target.value, ratio: event.target.value })}>
                {sizeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>生成数量</span>
              <select value={form.imageCount} onChange={(event) => setForm({ ...form, imageCount: Number(event.target.value) })}>
                {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} 张</option>)}
              </select>
            </label>
          </div>

          {form.generationType === 'image-to-image' ? (
            <>
              <label className="upload-box">
                <input type="file" accept="image/*" multiple onChange={handleReferenceUpload} />
                <span>{form.inputImages.length ? `继续添加参考图（${form.inputImages.length}/${maxReferenceImages}）` : '上传参考图'}</span>
              </label>
              <p className="reference-info">官方 GPT Image edits 最多支持 {maxReferenceImages} 张参考图。本应用限制参考图总大小约 {formatBytes(maxReferenceTotalBytes)}，避免接口请求过大失败。</p>
              {referenceSummary ? <p className="reference-info">{referenceSummary}</p> : null}
            </>
          ) : null}

          {form.inputImages.length ? <ReferenceGrid images={form.inputImages} onOpen={(image) => setLightboxJob({ imageUrl: image.dataUrl, prompt: image.name || '参考图', generationType: 'image-to-image', providerName: '参考图', referencePreview: true })} onRemove={(id) => setForm((current) => ({ ...current, inputImages: current.inputImages.filter((image) => image.id !== id) }))} /> : null}

          <button className="primary" type="submit" disabled={generating}>{generating ? '正在生成' : '开始生成'}</button>
        </form>

        <section className="card preview-card">
          <div className="section-head">
            <h2>预览区</h2>
            <span>{batchStatusLabel(previewBatch)}</span>
          </div>
          <BatchProgress batch={previewBatch} />
          <BatchPreview batch={previewBatch} user={user} token={token} onOpen={setLightboxJob} onCopy={copyPrompt} onDownload={handleDownloadJobs} downloadingIds={downloadingIds} />
        </section>
      </section>
      )}

      {toast ? createPortal(<div className="floating-toast">{toast}</div>, document.body) : null}
      {lightboxJob ? createPortal(<Lightbox job={lightboxJob} user={user} token={token} onClose={() => setLightboxJob(null)} onCopy={copyPrompt} onDownload={handleDownloadJobs} downloadingIds={downloadingIds} />, document.body) : null}
    </main>
  );
}

function batchKeyOf(job) {
  return job?.batchId || job?.id || '';
}

function createPendingBatch(form, count, providerName) {
  const batchId = `pending-${Date.now()}`;
  return Array.from({ length: count }, (_, index) => ({
    id: `${batchId}-${index}`,
    batchId,
    batchIndex: index,
    status: 'queued',
    progress: 1,
    progressMessage: '任务正在提交',
    providerName,
    generationType: form.generationType,
    prompt: form.prompt,
    imageUrl: '',
    pendingLocal: true
  }));
}

function groupJobsByBatch(list) {
  // 按 batchId 分组并保持任务顺序，兼容无 batchId 的旧记录（单张一组）。
  const groups = new Map();
  for (const job of list) {
    const key = batchKeyOf(job);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return Array.from(groups.values()).map((group) => [...group].sort((a, b) => (a.batchIndex || 0) - (b.batchIndex || 0)));
}

function batchStatusLabel(batch) {
  if (!batch?.length) return '待生成';
  const completed = batch.filter((job) => job.status === 'completed').length;
  const failed = batch.filter((job) => job.status === 'failed').length;
  if (completed + failed === batch.length) {
    if (batch.length === 1) return failed ? '生成失败' : '已完成';
    return failed ? `完成 ${completed}/${batch.length}（${failed} 张失败）` : '已完成';
  }
  return batch.length === 1 ? '生成中' : `生成中 ${completed}/${batch.length}`;
}

function BatchProgress({ batch }) {
  if (!batch?.length) {
    return <div className="progress-panel idle">提交任务后，这里会显示实时进度。</div>;
  }

  const pending = batch.filter((job) => job.status === 'queued' || job.status === 'running');
  // 全部终态后不再占位显示进度条；失败详情由预览网格内联展示。
  if (!pending.length) return null;

  // 多张并行时展示整体进度（取各任务进度均值）。
  const overall = Math.round(batch.reduce((total, job) => total + (job.status === 'completed' ? 100 : job.progress || 0), 0) / batch.length);
  const leader = pending[0];

  return (
    <div className="progress-panel saving-panel">
      <div className="progress-copy">
        <strong>{leader.progressMessage}<span className="saving-dots" aria-hidden="true"><i /> <i /> <i /></span></strong>
        <span>{leader.providerName} · {leader.generationType === 'image-to-image' ? '图生图' : '文生图'}{batch.length > 1 ? ` · 共 ${batch.length} 张` : ''}</span>
      </div>
      {overall >= 86 ? <p className="saving-hint">图片已经进入最后处理阶段，正在写入历史记录和生成可预览链接。</p> : null}
      <div className="progress-track active-save">
        <div className="progress-fill" style={{ width: `${overall}%` }} />
      </div>
      <div className="progress-meta">
        <span>{batch.length > 1 ? `${batch.filter((job) => job.status === 'completed').length}/${batch.length} 完成` : leader.status}</span>
        <span>{overall}%</span>
      </div>
    </div>
  );
}

function BatchPreview({ batch, user, token, onOpen, onCopy, onDownload, downloadingIds = [] }) {
  if (!batch?.length) {
    return <div className="empty-preview">完成后的图片会出现在这里</div>;
  }

  if (batch.length === 1) {
    return <ImagePreview job={batch[0]} user={user} token={token} onOpen={onOpen} onCopy={onCopy} onDownload={onDownload} downloadingIds={downloadingIds} />;
  }

  const anyCompleted = batch.some((job) => job.status === 'completed' && job.imageUrl);
  const allFailed = batch.every((job) => job.status === 'failed');

  if (allFailed) {
    return <div className="empty-preview error-preview">生成失败：{failureHint(batch[0].error || '生成失败，请稍后重试。')}</div>;
  }

  return (
    <article className="image-result">
      <div className="batch-grid">
        {batch.map((job, index) => (
          <div className="batch-cell" key={job.id}>
            {job.status === 'completed' && job.imageUrl ? (
              <button className="image-button" type="button" onClick={() => onOpen(job)}>
                <img src={imageSrc(job.imageUrl, token)} alt={`${job.prompt}（第 ${index + 1} 张）`} />
              </button>
            ) : job.status === 'failed' ? (
              <div className="batch-placeholder failed">第 {index + 1} 张失败{job.error ? `：${failureHint(job.error)}` : ''}</div>
            ) : (
              <div className="batch-placeholder">第 {index + 1} 张 · {job.progress || 0}%</div>
            )}
          </div>
        ))}
      </div>
      {anyCompleted ? <ImageCaption job={batch.find((job) => job.status === 'completed' && job.imageUrl) || batch[0]} jobs={batch} user={user} token={token} onCopy={onCopy} onDownload={onDownload} downloadingIds={downloadingIds} showOwner={false} /> : null}
    </article>
  );
}

function JobProgress({ job }) {
  if (!job) {
    return <div className="progress-panel idle">提交任务后，这里会显示实时进度。</div>;
  }

  const running = job.status === 'queued' || job.status === 'running';
  const waitingForSave = running && job.progress >= 86;

  return (
    <div className={job.status === 'failed' ? 'progress-panel failed-panel' : running ? 'progress-panel saving-panel' : 'progress-panel'}>
      <div className="progress-copy">
        <strong>{job.progressMessage}{running ? <span className="saving-dots" aria-hidden="true"><i /> <i /> <i /></span> : null}</strong>
        <span>{job.providerName} · {job.generationType === 'image-to-image' ? '图生图' : '文生图'}</span>
      </div>
      {waitingForSave ? <p className="saving-hint">图片已经进入最后处理阶段，正在写入历史记录和生成可预览链接。</p> : null}
      {job.error ? <p className="error-hint">{failureHint(job.error)}</p> : null}
      {job.warning ? <p className="warning-hint">{job.warning}</p> : null}
      <div className={running ? 'progress-track active-save' : 'progress-track'}>
        <div className="progress-fill" style={{ width: `${job.progress}%` }} />
      </div>
      <div className="progress-meta">
        <span>{job.status}</span>
        <span>{job.progress}%</span>
      </div>
    </div>
  );
}

function ProviderTabs({ models, selectedId, onSelect }) {
  return (
    <div className="provider-tabs">
      {models.map((model) => (
        <button key={model.id} className={model.id === selectedId ? 'active' : ''} type="button" onClick={() => onSelect(model.id)}>
          {model.id.includes('grok') ? 'Grok' : 'GPT'}
        </button>
      ))}
    </div>
  );
}

function GenerationTypePicker({ models, form, setForm, setReferenceInfo }) {
  const selected = models.find((model) => model.id === form.providerId);

  return (
    <div className="segmented">
      <button className={form.generationType === 'text-to-image' ? 'active' : ''} type="button" onClick={() => {
        setForm({ ...form, generationType: 'text-to-image', inputImages: [] });
        setReferenceInfo('');
      }}>文生图</button>
      <button className={form.generationType === 'image-to-image' ? 'active' : ''} type="button" disabled={!selected?.supportsImageToImage} onClick={() => setForm({ ...form, generationType: 'image-to-image' })}>
        图生图
      </button>
    </div>
  );
}

function ReferenceGrid({ images, token = '', onOpen, onRemove, readonly = false }) {
  return (
    <div className="reference-grid">
      {images.map((image, index) => (
        <div className="reference-thumb" key={image.id || `${image.dataUrl}-${index}`}>
          <button type="button" onClick={() => onOpen(image)}>
            <img src={imageSrc(image.dataUrl || image, token)} alt={image.name || `参考图 ${index + 1}`} />
          </button>
          {!readonly ? <button className="reference-remove" type="button" aria-label="删除参考图" onClick={() => onRemove(image.id)}>×</button> : null}
        </div>
      ))}
    </div>
  );
}

function MethodPicker({ models, form, setForm, setProviderMethods }) {
  const selected = models.find((model) => model.id === form.providerId);

  if (form.generationType === 'image-to-image') return null;

  return (
    <div className="segmented four">
      {methods.map((method) => {
        const disabled = method.value === 'responses' ? !selected?.supportsResponses : method.value === 'chat' ? !selected?.supportsChatCompletions : false;
        return (
          <button key={method.value} className={form.method === method.value ? 'active' : ''} type="button" disabled={disabled} onClick={() => {
            setProviderMethods((current) => ({ ...current, [form.providerId]: method.value }));
            setForm({ ...form, method: method.value });
          }}>
            {method.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingsDialog({ inline = false, settings, setSettings, availableModels, activeTab, setActiveTab, mode, onFetchModels, onSubmit, onClose }) {
  const [visibleKeys, setVisibleKeys] = useState({ gpt: false, grok: false });

  function handleClose(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    onClose();
  }

  const content = (
      <div className={inline ? 'settings-modal inline-settings-panel' : 'settings-modal'} onClick={(event) => event.stopPropagation()}>
        <form className="settings-card" onSubmit={(event) => event.preventDefault()}>
          <div className="section-head">
            <h2>{mode === 'admin' ? '默认模型配置' : '模型配置'}</h2>
            <span>{activeTab === 'gpt' ? 'GPT' : 'Grok'}</span>
          </div>
          <p className="muted compact">
            {mode === 'admin' ? '这里配置所有用户默认使用的模型服务。用户自己的模型配置会优先于默认配置。' : '未填写时会使用管理员默认配置；默认配置不可用时，生成任务会提示你自行配置或通知管理员。'}
          </p>
          <div className="segmented settings-tabs">
            <button className={activeTab === 'gpt' ? 'active' : ''} type="button" onClick={() => setActiveTab('gpt')}>GPT 配置</button>
            <button className={activeTab === 'grok' ? 'active' : ''} type="button" onClick={() => setActiveTab('grok')}>Grok 配置</button>
          </div>
          <div className="settings-grid">
            {activeTab === 'gpt' ? (
              <>
                <label className="field full">
                  <span>GPT Base URL</span>
                  <input value={settings.baseUrl} placeholder="https://api.openai.com/v1" onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} />
                </label>
                <SecretInput label="GPT API Key" value={settings.apiKey} placeholder="sk-..." visible={visibleKeys.gpt} onToggle={() => setVisibleKeys((current) => ({ ...current, gpt: !current.gpt }))} onChange={(value) => setSettings({ ...settings, apiKey: value })} />
                <ModelInput label="Images 模型" value={settings.generationModel} placeholder="gpt-image-2" models={availableModels.gpt || []} providerId="gpt" onFetchModels={onFetchModels} onChange={(value) => setSettings({ ...settings, generationModel: value })} />
                <ModelInput label="Edits 模型" value={settings.editModel} placeholder="gpt-image-2" models={availableModels.gpt || []} providerId="gpt" onFetchModels={onFetchModels} onChange={(value) => setSettings({ ...settings, editModel: value })} />
                <ModelInput label="Responses 模型" value={settings.responsesModel} placeholder="gpt-5.4-mini" models={availableModels.gpt || []} providerId="gpt" onFetchModels={onFetchModels} onChange={(value) => setSettings({ ...settings, responsesModel: value })} />
                <ModelInput label="Chat 模型" value={settings.chatModel} placeholder="gpt-5.4-mini" models={availableModels.gpt || []} providerId="gpt" onFetchModels={onFetchModels} onChange={(value) => setSettings({ ...settings, chatModel: value })} />
              </>
            ) : (
              <>
                <label className="field full">
                  <span>Grok Base URL</span>
                  <input value={settings.grokBaseUrl} placeholder="https://api.x.ai/v1" onChange={(event) => setSettings({ ...settings, grokBaseUrl: event.target.value })} />
                </label>
                <SecretInput label="Grok API Key" value={settings.grokApiKey} placeholder="xai-..." visible={visibleKeys.grok} onToggle={() => setVisibleKeys((current) => ({ ...current, grok: !current.grok }))} onChange={(value) => setSettings({ ...settings, grokApiKey: value })} />
                <ModelInput label="Grok 模型" value={settings.grokModel} placeholder="grok-imagine-image-quality" models={availableModels.grok || []} providerId="grok" onFetchModels={onFetchModels} onChange={(value) => setSettings({ ...settings, grokModel: value })} full />
              </>
            )}
          </div>
          <div className="settings-actions">
            <button className="ghost" type="button" onClick={handleClose}>关闭</button>
            <button className="primary" type="button" onClick={(event) => onSubmit(event, activeTab)}>保存{activeTab === 'gpt' ? ' GPT ' : ' Grok '}{mode === 'admin' ? '默认配置' : '配置'}</button>
          </div>
        </form>
      </div>
  );

  if (inline) return <section className="card inline-panel-wrap">{content}</section>;

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      {content}
    </div>
  );
}

function SecretInput({ label, value, placeholder, visible, onToggle, onChange }) {
  return (
    <label className="field full">
      <span>{label}</span>
      <span className="secret-input">
        <input type={visible ? 'text' : 'password'} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        <button type="button" aria-label={visible ? '隐藏 Key' : '显示 Key'} title={visible ? '隐藏 Key' : '显示 Key'} onClick={onToggle}>{visible ? '◉' : '◎'}</button>
      </span>
    </label>
  );
}

function PasswordDialog({ inline = false, form, setForm, onSubmit, onClose }) {
  const content = (
      <div className={inline ? 'settings-modal password-modal inline-settings-panel' : 'settings-modal password-modal'} onClick={(event) => event.stopPropagation()}>
        <form className="settings-card" onSubmit={onSubmit}>
          <div className="section-head">
            <h2>修改密码</h2>
            <span>Account</span>
          </div>
          <p className="muted compact">密码 6-20 位，支持英文、数字和常见特殊符号，输入空格会自动忽略。</p>
          <label className="field">
            <span>当前密码</span>
            <input type="password" value={form.currentPassword} maxLength="20" onChange={(event) => setForm({ ...form, currentPassword: sanitizePassword(event.target.value) })} />
          </label>
          <label className="field">
            <span>新密码</span>
            <input type="password" value={form.newPassword} maxLength="20" onChange={(event) => setForm({ ...form, newPassword: sanitizePassword(event.target.value) })} />
          </label>
          <div className="settings-actions">
            <button className="ghost" type="button" onClick={onClose}>关闭</button>
            <button className="primary" type="submit">保存新密码</button>
          </div>
        </form>
      </div>
  );

  if (inline) return <section className="card inline-panel-wrap">{content}</section>;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {content}
    </div>
  );
}

function ModelInput({ label, value, placeholder, models, providerId, onFetchModels, onChange, full }) {
  const listId = `available-models-${providerId}`;
  const inputId = `model-input-${providerId}-${label}`;

  return (
    <div className={full ? 'field full' : 'field'}>
      <div className="model-label">
        <label htmlFor={inputId}>{label}</label>
        <button className="model-fetch" type="button" title="基于当前 URL 和 Key 获取模型列表" aria-label="获取模型列表" onClick={(event) => onFetchModels(providerId, event)}>↻</button>
      </div>
      <input id={inputId} list={listId} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {models.map((model) => <option key={model} value={model} />)}
      </datalist>
    </div>
  );
}

function ImagePreview({ job, user, token, onOpen, onCopy, onDownload, downloadingIds = [] }) {
  if (job?.status === 'failed') {
    return <div className="empty-preview error-preview">生成失败：{failureHint(job.error || '生成失败，请稍后重试。')}</div>;
  }

  if (job?.status === 'queued' || job?.status === 'running') {
    return <div className="batch-placeholder preview-placeholder">图片生成中，完成后将在这里显示。</div>;
  }

  if (job?.status !== 'completed' || !job?.imageUrl) {
    return <div className="empty-preview">完成后的图片会出现在这里</div>;
  }

  return (
    <article className="image-result">
      <button className="image-button" type="button" onClick={() => onOpen(job)}>
        <img src={imageSrc(job.imageUrl, token)} alt={job.prompt} />
      </button>
      <ImageCaption job={job} user={user} token={token} onCopy={onCopy} onDownload={onDownload} downloadingIds={downloadingIds} showOwner={false} />
    </article>
  );
}

function ImageCaption({ job, jobs, user, token = '', onCopy, onDownload, onDelete, showOwner = true, showDelete = false, downloadingIds = [] }) {
  const downloadJobsList = (jobs?.length ? jobs : [job]).filter((item) => item?.status === 'completed' && item.imageUrl);
  const isDownloading = downloadJobsList.some((item) => downloadingIds.includes(item.id));

  function handleActionClick(event, action) {
    event.stopPropagation();
    action();
  }

  return (
    <div className="caption">
      {showOwner && user.role === 'admin' && job.username ? <p className="owner">账号：{job.username}</p> : null}
      <p>{job.prompt}</p>
      <div className="actions">
        <button type="button" onClick={(event) => handleActionClick(event, () => onCopy(job.prompt))}>复制提示词</button>
        <button className={isDownloading ? 'download-action loading' : 'download-action'} type="button" disabled={isDownloading} onClick={(event) => handleActionClick(event, () => onDownload(downloadJobsList))}>
          {isDownloading ? <><span className="mini-spinner" />正在下载</> : downloadJobsList.length > 1 ? `下载 ${downloadJobsList.length} 张图片` : '下载图片'}
        </button>
        {showDelete ? <button className="danger-action" type="button" onClick={(event) => handleActionClick(event, () => onDelete(job))}>删除记录</button> : null}
      </div>
    </div>
  );
}

function HistoryPage({ user, token, onOpen, onCopy, onToast, onDownload, downloadingIds = [] }) {
  const [groups, setGroups] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deleteConfirmGroup, setDeleteConfirmGroup] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('modal-open', Boolean(deleteConfirmGroup));
    return () => document.body.classList.remove('modal-open');
  }, [deleteConfirmGroup]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await api(`/api/history?page=${page}&pageSize=10`, { token });
        if (cancelled) return;
        setGroups(data.groups || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
        // 删除后当前页可能为空（比如最后一页只剩一条被删掉），自动回退一页。
        if (!data.groups?.length && page > 1) setPage(data.totalPages || 1);
      } catch (error) {
        if (!cancelled) onToast(error.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [token, page]);

  async function reload() {
    try {
      const data = await api(`/api/history?page=${page}&pageSize=10`, { token });
      setGroups(data.groups || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
      if (!data.groups?.length && page > 1) setPage(Math.min(page - 1, data.totalPages || 1));
    } catch (error) {
      onToast(error.message);
    }
  }

  async function handleDeleteGroup(group) {
    setDeleteConfirmGroup(null);
    setDeleting(true);

    try {
      // 删除整批：一批多张时逐条调用删除接口。
      await Promise.all(group.map((job) => api(`/api/jobs/${job.id}`, { method: 'DELETE', token })));
      onToast(user.role === 'admin' ? '历史记录已删除' : '历史记录已从你的列表移除');
      await reload();
    } catch (error) {
      onToast(error.message);
      await reload();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="card history-card history-page">
      <div className="section-head">
        <h2>{user.role === 'admin' ? '全部历史记录' : '我的历史记录'}</h2>
        <span>{total} 条</span>
      </div>
      {deleting ? <p className="inline-loading"><span /> 正在删除历史记录</p> : null}
      <div className="history-list">
        {loading ? <p className="muted">正在加载历史记录…</p> : groups.length ? groups.map((group) => (
          <HistoryItem key={batchKeyOf(group[0])} group={group} user={user} token={token} onOpen={onOpen} onCopy={onCopy} onDownload={onDownload} downloadingIds={downloadingIds} onDelete={setDeleteConfirmGroup} />
        )) : <p className="muted">暂无生成记录</p>}
      </div>
      {totalPages > 1 ? (
        <div className="pagination">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="pagination-info">第 {page} / {totalPages} 页</span>
          <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      ) : null}
      {deleteConfirmGroup ? createPortal(<ConfirmDialog group={deleteConfirmGroup} user={user} onCancel={() => setDeleteConfirmGroup(null)} onConfirm={() => handleDeleteGroup(deleteConfirmGroup)} />, document.body) : null}
    </section>
  );
}

function HistoryItem({ group, user, token, onOpen, onCopy, onDownload, downloadingIds = [], onDelete }) {
  const lead = group[0];
  const completedJobs = group.filter((job) => job.status === 'completed' && job.imageUrl);

  return (
    <article className="history-item">
      <button className="thumb" type="button" onClick={(event) => {
        event.stopPropagation();
        if (lead.imageUrl) onOpen(lead);
      }}>
        {lead.imageUrl ? <img src={imageSrc(lead.imageUrl, token)} alt={lead.prompt} /> : <span>{lead.progress}%</span>}
        {group.length > 1 ? <span className="batch-badge">{completedJobs.length}张</span> : null}
      </button>
      <div className="history-main">
        <div className="history-title">
          <strong>{lead.providerName} · {lead.generationType === 'image-to-image' ? '图生图' : '文生图'}{group.length > 1 ? ` · ${completedJobs.length} 张` : ''}</strong>
          <span className={`status ${lead.status}`}>{lead.status}</span>
        </div>
        {user.role === 'admin' && lead.username ? <p className="owner">账号：{lead.username}</p> : null}
        {group.length > 1 ? (
          <div className="history-batch-thumbs">
            {completedJobs.map((job, index) => (
              <button className="history-batch-thumb" key={job.id} type="button" onClick={(event) => {
                event.stopPropagation();
                onOpen(job);
              }}>
                <img src={imageSrc(job.imageUrl, token)} alt={`${job.prompt}（第 ${index + 1} 张）`} />
              </button>
            ))}
          </div>
        ) : null}
        {lead.inputImages?.length ? <ReferenceGrid images={lead.inputImages} token={token} readonly onOpen={(image) => onOpen({ imageUrl: image.dataUrl, prompt: image.name || '参考图', generationType: 'image-to-image', providerName: '参考图', referencePreview: true })} /> : null}
        {lead.imageUrl ? <ImageCaption job={lead} jobs={group} user={user} token={token} onCopy={onCopy} onDownload={onDownload} downloadingIds={downloadingIds} onDelete={() => onDelete(group)} showOwner={false} showDelete /> : null}
      </div>
    </article>
  );
}

function failureHint(message) {
  const text = String(message || '生成失败，请稍后重试。');
  if (/API Key|401|unauthorized/i.test(text)) return `${text} 请检查模型配置里的 API Key。`;
  if (/model|模型/i.test(text)) return `${text} 请检查模型名称，或点击模型配置中的获取模型列表。`;
  if (/size|resolution|分辨率/i.test(text)) return `${text} 可尝试选择自动分辨率。`;
  if (/timeout|network|fetch/i.test(text)) return `${text} 请检查接口地址或网络连通性。`;
  return text;
}

function ConfirmDialog({ group, user, onCancel, onConfirm }) {
  const lead = group[0];
  const description = user.role === 'admin'
    ? '管理员删除后，这条历史记录会从系统中永久移除。'
    : '';
  const batchDescription = group.length > 1 ? `本条记录共 ${group.length} 张图片，将一并删除。` : '';
  const confirmDescription = [description, batchDescription].filter(Boolean).join('');

  return (
    <div className="modal-backdrop confirm-backdrop" onClick={onCancel}>
      <div className="confirm-modal" onClick={(event) => event.stopPropagation()}>
        <div className="section-head">
          <h2>确认删除</h2>
          <span>{user.role === 'admin' ? '永久删除' : '删除记录'}</span>
        </div>
        {confirmDescription ? <p className="muted compact">{confirmDescription}</p> : null}
        <p className="confirm-prompt">{lead.prompt}</p>
        <div className="settings-actions confirm-actions">
          <button className="ghost" type="button" onClick={onCancel}>取消</button>
          <button className="primary danger-confirm" type="button" onClick={onConfirm}>确认删除</button>
        </div>
      </div>
    </div>
  );
}

function UsersPanel({ users, showAll, onToggleAll, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal users-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-card">
          <div className="section-head">
            <h2>用户管理</h2>
            <span>{users.length} 个账号</span>
          </div>
          <p className="muted compact">这里显示所有注册账号及其密码，密码默认隐藏，点击右侧按钮可一键全部显示或隐藏。</p>
          <div className="users-toolbar">
            <button type="button" onClick={onToggleAll}>{showAll ? '一键隐藏密码' : '一键显示密码'}</button>
          </div>
          <div className="users-table">
            <div className="users-row users-head">
              <span>账号</span>
              <span>密码</span>
              <span>角色</span>
              <span>注册时间</span>
            </div>
            {users.map((item) => (
              <div className="users-row" key={item.id}>
                <span className="users-name">{item.username}</span>
                <span className="users-password">{showAll ? item.password : '••••••••'}</span>
                <span>{item.role === 'admin' ? '管理员' : '用户'}</span>
                <span className="users-date">{item.createdAt ? item.createdAt.slice(0, 10) : '—'}</span>
              </div>
            ))}
            {!users.length ? <p className="muted">暂无注册账号</p> : null}
          </div>
          <div className="settings-actions">
            <button className="ghost" type="button" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Lightbox({ job, user, token, onClose, onCopy, onDownload, downloadingIds = [] }) {
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-panel" onClick={(event) => event.stopPropagation()}>
        <button className="close" type="button" onClick={onClose}>关闭</button>
        <img src={imageSrc(job.imageUrl, token)} alt={job.prompt} />
        {job.referencePreview ? <p className="reference-preview-caption">{job.prompt}</p> : <ImageCaption job={job} user={user} token={token} onCopy={onCopy} onDownload={onDownload} downloadingIds={downloadingIds} />}
      </div>
    </div>
  );
}

function imageSrc(url, token) {
  const text = String(url || '');
  if (!text || text.startsWith('data:') || text.startsWith('http://') || text.startsWith('https://')) return text;
  const separator = text.includes('?') ? '&' : '?';
  return `${text}${separator}token=${encodeURIComponent(token || '')}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  // 空 body（如 304 / 204）时 response.json() 会抛错，这里容错处理。
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }

  return data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

async function compressImage(file) {
  if (!file.type.startsWith('image/')) {
    throw new Error('请上传图片文件。');
  }

  const source = await fileToDataUrl(file);
  const image = await loadImage(source);
  const maxSide = 1536;
  const targetBytes = 950_000;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.86;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);

  while (dataUrlToBytes(dataUrl) > targetBytes && quality > 0.36) {
    quality -= 0.07;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }

  while (dataUrlToBytes(dataUrl) > targetBytes && canvas.width > 768 && canvas.height > 768) {
    const nextCanvas = document.createElement('canvas');
    const nextContext = nextCanvas.getContext('2d');
    nextCanvas.width = Math.round(canvas.width * 0.86);
    nextCanvas.height = Math.round(canvas.height * 0.86);
    nextContext.drawImage(canvas, 0, 0, nextCanvas.width, nextCanvas.height);
    canvas.width = nextCanvas.width;
    canvas.height = nextCanvas.height;
    context.drawImage(nextCanvas, 0, 0);
    dataUrl = canvas.toDataURL('image/jpeg', 0.42);
  }

  return {
    dataUrl,
    bytes: dataUrlToBytes(dataUrl),
    width: canvas.width,
    height: canvas.height
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解析失败'));
    image.src = src;
  });
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadImage(job, token = '') {
  const anchor = document.createElement('a');
  anchor.href = imageSrc(job.imageUrl, token);
  anchor.download = `image-studio-${job.id}.png`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function downloadJobs(jobs, token = '') {
  if (jobs.length === 1) {
    const item = await fetchJobImage(jobs[0], token);
    triggerBlobDownload(item.blob, imageFileName(jobs[0], item.blob.type));
    return;
  }

  const files = await Promise.all(jobs.map(async (job, index) => {
    const item = await fetchJobImage(job, token);
    return {
      name: `${String(index + 1).padStart(2, '0')}-${imageFileName(job, item.blob.type)}`,
      data: new Uint8Array(await item.blob.arrayBuffer())
    };
  }));
  const zip = createZip(files);
  triggerBlobDownload(zip, `image-studio-${batchKeyOf(jobs[0]) || Date.now()}.zip`);
}

async function fetchJobImage(job, token = '') {
  const response = await fetch(imageSrc(job.imageUrl, token), { cache: 'no-store' });
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
  return { blob: await response.blob() };
}

function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function imageFileName(job, mimeType = '') {
  const extension = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  return `image-studio-${job.id}.${extension}`;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const crc = crc32(file.data);
    const localHeader = createLocalZipHeader({ name, crc, size: file.data.length });
    localParts.push(localHeader, name, file.data);

    const centralHeader = createCentralZipHeader({ name, crc, size: file.data.length, offset });
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + file.data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = createEndZipRecord({ count: files.length, centralSize, centralOffset: offset });
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

function createLocalZipHeader({ name, crc, size }) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true);
  return bytes;
}

function createCentralZipHeader({ name, crc, size, offset }) {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  return bytes;
}

function createEndZipRecord({ count, centralSize, centralOffset }) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return bytes;
}

function crc32(data) {
  let crc = -1;
  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function sanitizeUsername(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[^A-Za-z]/g, '').slice(0, 15);
}

function sanitizePassword(value) {
  return String(value || '').replace(/\s+/g, '').slice(0, 20);
}

function sanitizeAuthForm(form) {
  return {
    username: sanitizeUsername(form.username),
    password: sanitizePassword(form.password)
  };
}

function validateAuthForm(form, { allowAdmin }) {
  if (!form.username) return '请输入账号。';
  if (!/^[A-Za-z]+$/.test(form.username)) return '账号只能使用英文字母。';
  if (form.username.length < 5) return '账号最少 5 位。';
  if (form.username.length > 15) return '账号最长 15 位。';
  if (!allowAdmin && form.username === 'admin') return '账号不能注册为 admin。';
  return validatePasswordValue(form.password);
}

function validatePasswordValue(password) {
  if (!password) return '请输入密码。';
  if (!/^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(password)) return '密码只能使用英文、数字和常见特殊符号。';
  if (password.length < 6) return '密码最少 6 位。';
  if (password.length > 20) return '密码最长 20 位。';
  return '';
}

function validatePasswordChangeForm(form) {
  const currentError = validatePasswordValue(sanitizePassword(form.currentPassword));
  if (currentError) return currentError.replace('密码', '当前密码');
  const nextError = validatePasswordValue(sanitizePassword(form.newPassword));
  if (nextError) return nextError.replace('密码', '新密码');
  if (form.currentPassword === form.newPassword) return '新密码不能和当前密码相同。';
  return '';
}

function validateGenerateForm(form, models) {
  const prompt = form.prompt.trim();
  const selected = models.find((model) => model.id === form.providerId);
  if (!form.providerId) return '请选择模型入口。';
  if (!selected) return '当前模型入口不可用，请刷新页面后重试。';
  if (!['text-to-image', 'image-to-image'].includes(form.generationType)) return '请选择正确的生成类型。';
  if (form.generationType === 'image-to-image' && !selected.supportsImageToImage) return '当前模型入口不支持图生图。';
  if (form.generationType === 'image-to-image' && !form.inputImages.length) return '请先上传参考图。';
  if (!prompt) return '请先输入提示词再开始生成。';
  if (prompt.length > 600) return '提示词最长 600 字。';
  if (!['auto', 'generations', 'responses', 'chat'].includes(form.method)) return '请选择正确的调用方式。';
  if (form.method === 'responses' && !selected.supportsResponses) return '当前模型入口不支持 Responses 调用方式。';
  if (form.method === 'chat' && !selected.supportsChatCompletions) return '当前模型入口不支持 Chat 调用方式。';
  if (!sizeOptions.some((option) => option.value === form.size)) return '请选择正确的分辨率。';
  const imageCount = Number(form.imageCount);
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 4) return '生成数量只能选择 1 到 4 张。';
  const totalBytes = form.inputImages.reduce((total, image) => total + Number(image.bytes || dataUrlToBytes(image.dataUrl)), 0);
  if (form.inputImages.length > maxReferenceImages) return `最多上传 ${maxReferenceImages} 张参考图。`;
  if (totalBytes > maxReferenceTotalBytes) return `参考图总大小最多 ${formatBytes(maxReferenceTotalBytes)}。`;
  return '';
}

function defaultSettings() {
  return {
    baseUrl: '',
    apiKey: '',
    generationModel: '',
    editModel: '',
    responsesModel: '',
    chatModel: '',
    grokBaseUrl: '',
    grokApiKey: '',
    grokModel: ''
  };
}

function installClientDiagnostics() {
  if (window.__imageStudioDiagnosticsInstalled) return;
  window.__imageStudioDiagnosticsInstalled = true;

  const sessionId = sessionStorage.getItem('image-studio-diagnostic-session') || createDiagnosticId();
  sessionStorage.setItem('image-studio-diagnostic-session', sessionId);

  let lastScrollAt = 0;
  let touchStartY = 0;
  const report = (event, detail = {}, keepalive = false) => {
    const payload = JSON.stringify({
      event,
      path: window.location.pathname,
      detail: {
        sessionId,
        y: Math.round(currentScrollContainer().scrollTop || window.scrollY || 0),
        visibility: document.visibilityState,
        ...detail
      }
    });

    if (keepalive && navigator.sendBeacon) {
      navigator.sendBeacon('/api/diagnostics/client', new Blob([payload], { type: 'application/json' }));
      return;
    }

    fetch('/api/diagnostics/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive
    }).catch(() => {});
  };

  report('app-mounted', {
    navigationType: performance.getEntriesByType('navigation')[0]?.type || 'unknown',
    referrer: document.referrer || ''
  });

  window.addEventListener('pageshow', (event) => report('pageshow', { persisted: event.persisted }));
  window.addEventListener('pagehide', (event) => report('pagehide', { persisted: event.persisted }, true));
  window.addEventListener('beforeunload', () => report('beforeunload', { lastScrollAt }, true));
  document.addEventListener('visibilitychange', () => report('visibilitychange'));
  document.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - lastScrollAt < 1200) return;
    lastScrollAt = now;
    report('scroll-sample');
  }, { passive: true, capture: true });
  window.addEventListener('touchstart', (event) => {
    touchStartY = event.touches?.[0]?.clientY || 0;
  }, { passive: true });
  window.addEventListener('touchmove', (event) => {
    const currentY = event.touches?.[0]?.clientY || 0;
    const scroller = currentScrollContainer(event.target);
    const movingDownAtTop = scroller.scrollTop <= 0 && currentY > touchStartY;
    const movingUpAtBottom = Math.ceil(scroller.clientHeight + scroller.scrollTop) >= scroller.scrollHeight && currentY < touchStartY;
    if (movingDownAtTop || movingUpAtBottom) {
      report('blocked-edge-touch', { movingDownAtTop, movingUpAtBottom });
    }
  }, { passive: true });
  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('a, button, input, select, textarea, label');
    if (!target) return;
    report('interaction', {
      tag: target.tagName,
      type: target.getAttribute('type') || '',
      href: target.getAttribute('href') || '',
      text: target.textContent?.slice(0, 40) || ''
    });
  }, true);

  if (import.meta.hot) {
    import.meta.hot.on('vite:beforeFullReload', (payload) => report('vite-before-full-reload', { payload }, true));
    import.meta.hot.on('vite:beforeUpdate', (payload) => report('vite-before-update', { updates: payload?.updates?.map((item) => item.path) || [] }));
    import.meta.hot.on('vite:error', (payload) => report('vite-error', { message: payload?.err?.message || '' }));
  }
}

function shouldInstallClientDiagnostics() {
  return new URLSearchParams(window.location.search).get('debugRefresh') === '1' || localStorage.getItem('image-studio-debug-refresh') === '1';
}

function currentScrollContainer(target) {
  const targetScroller = target?.closest?.('.settings-modal, .lightbox-panel, .app-shell, .login-page');
  if (targetScroller) return targetScroller;
  return document.querySelector('.settings-modal, .lightbox-panel, .app-shell, .login-page') || document.scrollingElement || document.documentElement;
}

function createDiagnosticId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `diag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validateSettingsForTab(settings, tab, options = {}) {
  const requireComplete = Boolean(options.requireComplete);
  const allowPartialModels = Boolean(options.allowPartialModels);

  if (tab === 'gpt') {
    if (requireComplete && !settings.baseUrl && !settings.apiKey && !allowPartialModels && !settings.generationModel && !settings.editModel && !settings.responsesModel && !settings.chatModel) return '请先填写 GPT Base URL、API Key，并至少填写一个 GPT 模型后再保存。';
    if (requireComplete && !settings.baseUrl) return '请填写 GPT Base URL。';
    if (requireComplete && !settings.apiKey) return '请填写 GPT API Key。';
    if (requireComplete && !allowPartialModels && !settings.generationModel && !settings.editModel && !settings.responsesModel && !settings.chatModel) return '请至少填写一个 GPT 模型。';
    if (settings.baseUrl && !/^https?:\/\//.test(settings.baseUrl)) return 'GPT Base URL 必须以 http:// 或 https:// 开头。';
    if (settings.apiKey && !settings.baseUrl) return '填写 GPT API Key 后，请同时填写 GPT Base URL。';
    if (settings.baseUrl && !settings.apiKey) return '填写 GPT Base URL 后，请同时填写 GPT API Key。';
    if (!allowPartialModels && settings.baseUrl && !settings.generationModel && !settings.editModel && !settings.responsesModel && !settings.chatModel) return '请至少填写一个 GPT 模型。';
  }

  if (tab === 'grok') {
    if (requireComplete && !settings.grokBaseUrl && !settings.grokApiKey && !allowPartialModels && !settings.grokModel) return '请先填写 Grok Base URL、API Key 和模型后再保存。';
    if (requireComplete && !settings.grokBaseUrl) return '请填写 Grok Base URL。';
    if (requireComplete && !settings.grokApiKey) return '请填写 Grok API Key。';
    if (requireComplete && !allowPartialModels && !settings.grokModel) return '请填写 Grok 模型。';
    if (settings.grokBaseUrl && !/^https?:\/\//.test(settings.grokBaseUrl)) return 'Grok Base URL 必须以 http:// 或 https:// 开头。';
    if (settings.grokApiKey && !settings.grokBaseUrl) return '填写 Grok API Key 后，请同时填写 Grok Base URL。';
    if (settings.grokBaseUrl && !settings.grokApiKey) return '填写 Grok Base URL 后，请同时填写 Grok API Key。';
    if (!allowPartialModels && settings.grokBaseUrl && !settings.grokModel) return '请填写 Grok 模型。';
  }

  return '';
}

createRoot(document.getElementById('root')).render(<App />);
