# Image Studio

一个支持账号、异步任务、历史记录和多模型适配的图片生成 Web 项目，包含 React 前端、Express 后端、Vite 反向代理和本地模拟生图接口。

## 功能

- 支持 GPT 和 Grok 两个模型入口，顶部使用单选按钮切换
- GPT 接口配置参考 `codegrazier/cpa-image`：只需要填写 Base URL、API Key 和模型名
- GPT 支持 Images、Responses、Chat 三种文生图调用方式，以及 Edits 图生图调用方式
- 分辨率最高支持到 2K，并在界面中标注常用名称
- 文生图和图生图由用户显式选择，选择图生图后才显示上传入口
- 图生图参考图会在浏览器内压缩到最长边 1536 像素，并尽量控制在约 1.8 MB 内
- 支持用户注册和登录，注册账号不能为 `admin`
- 管理员可查看所有账号历史记录，普通账号只查看自己的记录
- 图片生成采用异步任务，关闭页面后重新进入可恢复任务状态
- 生成过程中展示进度条和阶段说明
- 生成完成后提供预览区、历史记录、复制提示词、下载图片、点击放大预览
- 前端通过 `/api` 反向代理访问后端

## 开发

```bash
# 安装依赖
npm install

# 启动前端和后端
npm run dev
```

前端默认运行在 `5173` 端口，后端默认运行在 `3001` 端口。

## 模型配置

模型入口基础定义在 `config/models.json`，用户登录后可点击右上角「接口配置」按钮，在弹窗中填写自己的 URL、Key 和 Model。

配置优先级：

- 用户自己的接口配置
- 管理员通过环境变量配置的默认值
- 两者都缺失时，生成任务会提示用户自行配置或通知管理员

接口配置弹窗支持一键获取模型列表，填写 URL 和 Key 后点击「获取 GPT 模型」或「获取 Grok 模型」即可拉取 `/v1/models`。

GPT 调用方式参考 `codegrazier/cpa-image` 的 endpoint 规范化策略：如果填写的是 `https://example.com/v1`，后端会自动拼接到对应路由。

GPT 支持以下官方或 OpenAI 兼容路由：

- 文生图：`POST /v1/images/generations`，JSON 请求体
- 图生图：`POST /v1/images/edits`，multipart form-data，请求字段使用 `image[]`
- Responses 生图：`POST /v1/responses`，使用 `image_generation` tool
- Chat 生图：`POST /v1/chat/completions`，使用 `image_generation` tool
- 自动模式：优先使用 Images 模型，其次 Responses 模型，最后 Chat 模型

Grok 使用 xAI 官方 Images API：

- 文生图：`POST https://api.x.ai/v1/images/generations`，JSON 请求体
- 当前配置按官方文档只启用文生图

新增 OpenAI 兼容模型入口时添加一条基础配置即可：

```json
{
  "id": "custom-openai-image",
  "name": "Custom OpenAI Image",
  "provider": "openai",
  "modeLabel": "自定义模型",
  "defaultBaseUrl": "https://example.com/v1",
  "defaultGenerationModel": "gpt-image-2",
  "defaultEditModel": "gpt-image-2",
  "defaultResponsesModel": "gpt-5.4-mini",
  "defaultChatModel": "gpt-5.4-mini",
  "apiKeyEnv": "CUSTOM_IMAGE_API_KEY",
  "supportsTextToImage": true,
  "supportsImageToImage": true,
  "supportsResponses": true,
  "supportsChatCompletions": true,
  "responseFormat": "b64_json"
}
```

字段说明：

- `defaultBaseUrl`：默认接口地址，可填到 `/v1` 或具体路由，后端会规范化到需要的路由
- `apiKeyEnv`：后端读取的环境变量名
- `defaultGenerationModel`：Images 文生图默认模型
- `defaultEditModel`：Edits 图生图默认模型
- `defaultResponsesModel`：Responses 生图默认模型
- `defaultChatModel`：Chat 生图默认模型
- `supportsImageToImage`：是否在前端允许图生图
- `extraPayload`：可选，追加到请求体里的固定参数

未配置对应密钥时，后端自动使用本地 SVG 模拟生成。

```bash
# GPT Image 2 接口密钥，对应 config/models.json 中的 apiKeyEnv
export GPT_IMAGE_API_KEY="<GPT_IMAGE_API_KEY>"

# xAI Grok 图片接口密钥
export XAI_API_KEY="<XAI_API_KEY>"
```

真实接口返回图片 URL 或 `b64_json` 均可，后端会统一返回给前端展示。

## 上传限制

前端会把图生图参考图压缩到约 1 MB 以内，超过目标体积时会继续降低质量并缩小尺寸。后端默认请求体限制为 `12mb`，图生图参考图默认最大字符串长度为 `1400000`。可通过环境变量调整：

```bash
# 调整 JSON 请求体限制
export JSON_BODY_LIMIT="16mb"

# 调整参考图最大 data URL 字符串长度，默认约 1 MB 图片体积
export MAX_INPUT_IMAGE_LENGTH="1400000"
```

## 管理员默认配置

```bash
# GPT 默认配置
export DEFAULT_GPT_BASE_URL="https://api.openai.com/v1"
export DEFAULT_GPT_API_KEY="<GPT_IMAGE_API_KEY>"
export DEFAULT_GPT_IMAGE_MODEL="gpt-image-2"
export DEFAULT_GPT_EDIT_MODEL="gpt-image-2"
export DEFAULT_GPT_RESPONSES_MODEL="gpt-5.4-mini"
export DEFAULT_GPT_CHAT_MODEL="gpt-5.4-mini"

# Grok 默认配置
export DEFAULT_GROK_BASE_URL="https://api.x.ai/v1"
export DEFAULT_GROK_API_KEY="<XAI_API_KEY>"
export DEFAULT_GROK_IMAGE_MODEL="grok-imagine-image-quality"
```

## 数据

账号和生成任务持久化在 `data/store.json`。开发模式重启服务后，运行中的任务会自动恢复并继续完成。

## 账号规则

- 普通用户从注册入口创建账号
- 默认管理员账号为 `admin`，默认密码为 `admin123`，可通过 `DEFAULT_ADMIN_PASSWORD` 环境变量覆盖
- 账号区分大小写，只能使用英文字母
- 账号最少 5 位，最长 15 位
- 密码区分大小写，支持英文、数字和常见特殊符号
- 密码最少 6 位，最长 20 位
- 输入中的空格会被自动忽略
- 注册账号不能为 `admin`
