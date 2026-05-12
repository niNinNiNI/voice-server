# ESP32 Volcengine Bridge Server

本地桥接服务器，连接 ESP32 固件与火山引擎云端语音服务（ASR 语音识别 + TTS 语音合成）。

## 架构概览

```
┌─────────┐   WebSocket (JSON)    ┌──────────────────┐   WebSocket (Binary Protocol)   ┌──────────────┐
│  ESP32  │◄─────────────────────►│  Bridge Server    │◄──────────────────────────────►│  火山引擎云端  │
│  固件   │   PCM音频 / 控制指令   │  (Node.js)        │   ASR + TTS 双向流式协议         │  ASR / TTS   │
└─────────┘                       │  Port: 3000       │                                └──────────────┘
                                  │  /health          │
                                  └──────────────────┘
```

- **上行链路（ASR）**：ESP32 → PCM 音频 → 服务器 → 火山引擎 ASR → 识别文本 → 服务器 → ESP32
- **下行链路（TTS）**：ESP32 收到 ASR 最终结果后自动触发 → 火山引擎 TTS → Opus 音频包 → 服务器透传 → ESP32 播放
- **协议实现**：完整实现了火山引擎双向流式 WebSocket 二进制协议（v3），包括消息组包/解包、连接/会话生命周期管理

## 项目结构

```
语音服务器/
├── src/
│   ├── bin/
│   │   └── server_main.ts          # 入口，CLI 参数解析
│   ├── server/
│   │   ├── local_server.ts         # 核心服务器：HTTP + WebSocket，ESP32 桥接
│   │   ├── volc_asr_manager.ts     # 火山引擎 ASR 管理器（状态机，自动重连）
│   │   ├── volc_tts_manager.ts     # 火山引擎 TTS 管理器（状态机，自动重连）
│   │   └── ogg_demuxer.ts          # Ogg 容器解复用器（提取 Opus 音频包）
│   └── protocols.ts                # 火山引擎双向流式二进制协议实现
├── scripts/
│   └── status.sh                   # 服务器状态检测脚本（健康检查 + WS 连通性测试）
├── sauc_demo/                      # 火山引擎 ASR Java SDK 示例（参考）
├── volcengine_bidirection_demo _java/  # 火山引擎双向流式 TTS Java SDK 示例（参考）
├── 流式语音识别.md                  # 火山引擎流式 ASR API 文档
├── WebSocket双向流式接口文档.md      # 火山引擎双向流式 TTS API 文档
├── esp期望格式.md                   # ESP32 通信协议期望格式
└── 火山应用信息.md                   # 火山引擎应用凭证
```

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装

```bash
cd 语音服务器
npm install
```

### 配置

复制并编辑环境变量文件 `.env`：

```env
# 火山引擎应用凭证
VOLC_APP_ID=你的APP_ID
VOLC_ACCESS_TOKEN=你的ACCESS_TOKEN

# ASR 配置
VOLC_ASR_RESOURCE_ID=volc.bigasr.sauc.duration

# TTS 配置
VOLC_TTS_RESOURCE_ID=volc.megatts.default
VOLC_VOICE_TYPE=zh_female_shuangkuaisisi_moon_bigtts
```

### 启动服务器

```bash
# 使用 .env 中的默认配置启动
npm start

# 或通过命令行参数覆盖配置
npm start -- \
  --port 3000 \
  --appid 你的APP_ID \
  --access_token 你的TOKEN \
  --voice_type zh_female_shuangkuaisisi_moon_bigtts \
  --sample_rate 24000
```

## CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | `3000` | HTTP / WebSocket 监听端口 |
| `--appid` | 环境变量 `VOLC_APP_ID` | 火山引擎应用 ID |
| `--access_token` | 环境变量 `VOLC_ACCESS_TOKEN` | 火山引擎 Access Token |
| `--asr_resource_id` | `volc.bigasr.sauc.duration` | ASR 资源 ID |
| `--tts_resource_id` | 根据 voice_type 自动推断 | TTS 资源 ID |
| `--voice_type` | `zh_female_shuangkuaisisi_moon_bigtts` | TTS 默认音色 |
| `--sample_rate` | `24000` | TTS 输出采样率 |
| `--no-reconnect` | `true`（启用） | 禁用云端服务自动重连 |

音色前缀为 `S_` 时，TTS 资源 ID 自动设为 `volc.megatts.default`，否则为 `volc.service_type.10029`。

## ESP32 通信协议

服务器与 ESP32 之间通过 WebSocket 传输 JSON 文本帧和二进制 PCM 音频帧。

### ESP32 → 服务器

| 消息类型 | 格式 | 说明 |
|----------|------|------|
| `asr_start` | JSON `{"type":"asr_start"}` | 开始录音，服务器开始接收 PCM 音频 |
| `asr_stop` | JSON `{"type":"asr_stop"}` | 停止录音，服务器结束 ASR 会话 |
| `ping` | JSON `{"type":"ping"}` | 心跳检测 |
| `tts_request` | JSON `{"type":"tts_request","text":"要合成的文本"}` | 测试用：跳过 ASR 直接触发 TTS 合成 |
| PCM 音频 | 二进制 `Buffer` | 16kHz / 16bit / 单声道 / 小端序 PCM |

### 服务器 → ESP32

| 消息类型 | 格式 | 说明 |
|----------|------|------|
| `status` | JSON `{"type":"status","message":"..."}` | 连接成功通知 |
| `asr_result` | JSON `{"type":"asr_result","text":"...","is_final":true/false}` | ASR 识别结果 |
| `tts_start` | JSON `{"type":"tts_start","sample_rate":24000,"channels":1}` | TTS 合成开始 |
| `tts_end` | JSON `{"type":"tts_end"}` | TTS 合成结束 |
| `pong` | JSON `{"type":"pong"}` | 心跳响应 |
| `error` | JSON `{"type":"error","message":"..."}` | 错误通知 |
| Opus 音频 | 二进制 `Buffer` | TTS 合成的 Opus 音频数据（Ogg 容器封装） |

### 典型交互流程

```
ESP32                    服务器                    火山引擎
  │                        │                         │
  │── asr_start ──────────►│                         │
  │                        │── PCM音频 ──────────────►│  ASR
  │── PCM音频 (连续) ──────►│── PCM音频 ──────────────►│
  │                        │◄── 识别结果文本 ──────────│
  │◄── asr_result ─────────│                         │
  │                        │                         │
  │── asr_stop ───────────►│                         │
  │                        │── 结束ASR会话 ──────────►│
  │                        │                         │
  │  (最终识别结果触发TTS)    │                         │
  │◄── tts_start ──────────│── 合成文本 ─────────────►│  TTS
  │◄── Opus音频包 ─────────│◄── Opus音频包 ───────────│
  │◄── Opus音频包 ─────────│◄── Opus音频包 ───────────│
  │◄── tts_end ────────────│◄── 会话结束 ─────────────│
```

## HTTP API

### GET /health

服务器健康检查端点。

```json
{
  "status": "ok",
  "esp32Connected": true,
  "asrConnected": true,
  "asrRecording": false,
  "ttsConnected": true,
  "ttsSynthesizing": false
}
```

### 状态检测脚本

```bash
# 检测本地服务器
bash scripts/status.sh

# 检测远程服务器
bash scripts/status.sh 192.168.1.100:3000
```

脚本会自动检测本机 IP 地址、服务器健康状态、云服务连接状态，以及 WebSocket 连通性。

## 核心模块说明

### protocols.ts — 火山引擎二进制协议

完整实现了火山引擎双向流式 WebSocket API v3 的二进制协议：
- 消息序列化/反序列化（`marshalMessage` / `unmarshalMessage`）
- 定义所有事件类型（`EventType`）：连接、会话、TTS、ASR、字幕、Chat 等
- 定义消息类型（`MsgType`）：完整请求/响应、纯音频、错误等
- 高级协议辅助函数：`StartConnection`、`StartSession`、`TaskRequest` 等
- WebSocket 消息队列机制（按连接缓存消息，支持异步等待特定事件）

### VolcAsrManager — ASR 管理器

- **状态机**：`Disconnected → Connecting → Connected → SessionActive → Disconnecting`
- **自动重连**：指数退避（1s → 2s → 4s → ... → 上限 30s）
- **音频配置**：16kHz / 16bit / 单声道 / raw PCM / 中文
- **识别模型**：bigmodel，启用 ITN（逆文本归一化）、标点、utterances
- 支持部分结果（实时）和最终结果（句子结束）回调

### VolcTtsManager — TTS 管理器

- **状态机**：同 ASR 管理器
- **自动重连**：同 ASR 管理器
- **按字符流式发送**：逐字符发送文本到 TTS 引擎，字符间隔 5ms
- **输出格式**：ogg_opus / 24kHz / 32kbps
- 使用 `OggDemuxer` 从 Ogg 容器中提取纯净 Opus 音频包
- 完整会话生命周期：`StartSession → 流式文字 → 接收音频 → FinishSession`

### OggDemuxer — Ogg 解复用器

按 RFC 3533 标准解析 Ogg 容器格式，提取原始 Opus 音频包：
- 容错处理：跳过损坏/不完整页面，自动搜索下一个 OggS 同步头
- 正确处理 BOS（Begin of Stream）、EOS（End of Stream）页面
- 根据 segment table 组包连续段为完整 Opus 包（segLen < 255 表示包边界）

## 开发

```bash
# 启动开发服务器
npm run dev

# 代码检查
npm run lint
npm run lint:fix

# 代码格式化
npm run prettier
```

### 技术栈

- **TypeScript 5.x** — 类型安全
- **ws** — WebSocket 服务端和客户端
- **commander** — CLI 参数解析
- **dotenv** — 环境变量加载
- **uuid** — 会话 ID 和连接 ID 生成
- **ESLint + Prettier** — 代码规范和格式化
