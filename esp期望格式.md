# 通信协议说明 — ESP32-P4 语音变声器

esp项目主程序地址：/home/nini/esp-claw/application/edge_agent/main

本项目运行在本地服务器模式，ESP32 通过 WebSocket 连接本地 服务器，所有音频数据和控制指令均通过 WebSocket 传输。

---

## ESP32 → 服务器（发送）

### WebSocket 文本帧（JSON 控制消息）

| 消息 | 格式 | 说明 |
|------|------|------|
| ASR 开始 | `{"type":"asr_start"}` | 通知服务器开始语音识别 |
| ASR 结束 | `{"type":"asr_stop"}` | 通知服务器结束语音识别 |
| 心跳 | `{"type":"ping"}` | 保持连接活跃 |

### WebSocket 二进制帧（音频数据）

- **PCM 原始音频**：16-bit signed integer，单声道，16kHz 采样率
- 每块 **640 字节**（= 20ms 时长的音频，计算公式：16000 × 2 × 1 × 0.02）
- 在 `asr_start` 和 `asr_stop` 之间持续发送

---

## 服务器 → ESP32（接收）

### WebSocket 文本帧（JSON 控制消息）

**ASR 识别结果：**

```json
{
  "type": "asr_result",
  "text": "识别出的文字内容",
  "is_final": true
}
```

- `is_final: false` — 中间结果（边说边识别，每次返回完整句子的当前候选）
- `is_final: true` — 最终结果，ESP32 收到后自动触发 TTS 合成

**TTS 开始：**

```json
{
  "type": "tts_start",
  "sample_rate": 24000,
  "channels": 1
}
```

**TTS 结束：**

```json
{"type": "tts_end"}
```

**服务器状态：**

```json
{"type": "status", "message": "some status info"}
```

**心跳响应：**

```json
{"type": "pong"}
```

**错误消息：**

```json
{"type": "error", "message": "错误描述"}
```

### WebSocket 二进制帧

- **Opus 音频包**：原始 Opus 编码数据（非 Ogg 容器格式）
- 在 `tts_start` 和 `tts_end` 之间由服务器持续推送
- ESP32 端用 Opus 解码器解码为 16-bit PCM 后通过 I2S 播放

---

## 完整通信流程

```
┌─────────────────────────────────────────────────────┐
│ 用户按住 "Hold to Speak" 按钮                        │
│     ↓                                               │
│ ESP32 → Server: {"type":"asr_start"}                │
│     ↓                                               │
│ ESP32 → Server: PCM 二进制帧 (640 bytes/chunk)       │  ← 持续发送
│     ↓                                               │
│ 用户松开按钮                                         │
│     ↓                                               │
│ ESP32 → Server: 发送剩余 PCM，然后 {"type":"asr_stop"}│
│     ↓                                               │
│ Server → ESP32: {"type":"asr_result", "text":"...", │
│                   "is_final":true}                   │
│     ↓                                               │
│ Server → ESP32: {"type":"tts_start",                │
│                   "sample_rate":24000, "channels":1} │
│     ↓                                               │
│ Server → ESP32: Opus 二进制帧                        │  ← 持续接收
│     ↓                                               │
│ Server → ESP32: {"type":"tts_end"}                  │
│     ↓                                               │
│ 播放完毕，回到 Ready 状态                             │
└─────────────────────────────────────────────────────┘
```

---

## 关键参数

| 参数 | 值 |
|------|-----|
| 音频采样率 | 16000 Hz |
| 位深 | 16 bit |
| 声道 | 1（单声道） |
| PCM 块大小 | 640 字节（20ms） |
| WebSocket 缓冲区 | 16384 字节 |
| 断线自动重连间隔 | 5000 ms |
| 连接超时 | 15000 ms |
| PCM 发送超时 | 1000 ms |
| JSON 发送超时 | 3000 ms |

---

## 关键源码

| 文件 | 内容 |
|------|------|
| `main/server_client.c:69-118` | WebSocket JSON 消息构造与解析 |
| `main/server_client.c:120-161` | WebSocket 事件分发（文本帧/二进制帧） |
| `main/audio_pipeline.c:109-171` | 麦克风采集任务，PCM 流式发送 |
| `main/audio_pipeline.c:174-202` | Opus 解码任务，解码后送入播放 ring buffer |
| `main/app_main.c:110-153` | ASR/TTS/Server 回调注册 |
