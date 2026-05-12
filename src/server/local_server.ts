import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import { VolcAsrManager } from './volc_asr_manager'
import { VolcTtsManager } from './volc_tts_manager'

export interface ServerOptions {
  port: number
  appId: string
  accessToken: string
  asrResourceId: string
  ttsResourceId: string
  voiceType: string
  ttsSampleRate: number
}

export class LocalServer {
  private httpServer: http.Server
  private wss: WebSocketServer
  private esp32Ws: WebSocket | null = null
  private asr: VolcAsrManager
  private tts: VolcTtsManager
  private options: ServerOptions
  private asrRecording = false
  private ttsSynthesizing = false
  private lastFinalAsrText = ''
  private oggChunks: Buffer[] = []
  private recordingsDir = path.resolve(__dirname, '..', '..', 'recordings')

  constructor(options: ServerOptions) {
    this.options = options

    this.httpServer = http.createServer((req, res) => {
      this.handleHttp(req, res)
    })

    this.wss = new WebSocketServer({ server: this.httpServer })

    this.asr = new VolcAsrManager(
      options.appId,
      options.accessToken,
      options.asrResourceId,
    )

    this.tts = new VolcTtsManager(
      options.appId,
      options.accessToken,
      options.ttsResourceId,
      options.voiceType,
    )

    this.setupCallbacks()
  }

  // --- Callback wiring ---

  private setupCallbacks(): void {
    this.asr.setCallbacks({
      onResult: (text, isFinal) => {
        console.log(
          `[ASR] ${isFinal ? 'FINAL' : 'PARTIAL'}: "${text}"`,
        )
        this.sendToEsp({
          type: 'asr_result',
          text,
          is_final: isFinal,
        })

        // Auto-trigger TTS on final non-empty result
        if (isFinal && text.trim()) {
          this.triggerTts(text.trim())
        }
      },
      onError: (err) => {
        console.error(`[ASR] Error: ${err}`)
        this.sendToEsp({ type: 'error', message: err })
      },
      onStatus: (status) => {
        console.log(`[ASR] Status: ${status}`)
      },
    })

    this.tts.setCallbacks({
      onOpusPacket: (packet) => {
        if (
          this.esp32Ws &&
          this.esp32Ws.readyState === WebSocket.OPEN
        ) {
          this.esp32Ws.send(packet)
        }
      },
      onOggPage: (page) => {
        this.oggChunks.push(page)
      },
      onSentenceStart: () => {
        console.log('[TTS] Sentence started')
      },
      onSentenceEnd: () => {
        console.log('[TTS] Sentence ended')
      },
      onSessionFinished: (sessionId) => {
        this.sendToEsp({ type: 'tts_end' })
        this.ttsSynthesizing = false
        this.saveRecording(sessionId)
        console.log('[TTS] Playback complete')
      },
      onError: (err) => {
        console.error(`[TTS] Error: ${err}`)
        this.sendToEsp({ type: 'error', message: err })
        this.ttsSynthesizing = false
      },
      onStatus: (status) => {
        console.log(`[TTS] Status: ${status}`)
      },
    })
  }

  // --- HTTP handling ---

  private handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, OPTIONS',
    )
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = req.url || '/'

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          esp32Connected:
            this.esp32Ws !== null &&
            this.esp32Ws.readyState === WebSocket.OPEN,
          asrConnected: this.asr.isConnected(),
          asrRecording: this.asrRecording,
          ttsConnected: this.tts.isConnected(),
          ttsSynthesizing: this.ttsSynthesizing,
        }),
      )
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  // --- Server lifecycle ---

  start(): Promise<void> {
    return new Promise((resolve) => {
      // Connect to cloud services
      Promise.all([this.asr.connect(), this.tts.connect()])
        .then(() => {
          console.log('[Server] Cloud connections established')
        })
        .catch((err) => {
          console.error(
            '[Server] Failed to connect to cloud:',
            err,
          )
        })

      // ESP32 WebSocket handler
      this.wss.on('connection', (ws) => {
        console.log('[Server] ESP32 connected')

        if (this.esp32Ws && this.esp32Ws !== ws) {
          this.esp32Ws.close()
        }
        this.esp32Ws = ws

        ws.on('message', (data: Buffer) => {
          this.handleEspMessage(data)
        })

        ws.on('close', () => {
          console.log('[Server] ESP32 disconnected')
          if (this.esp32Ws === ws) {
            this.esp32Ws = null
            this.asrRecording = false
          }
        })

        ws.on('error', (err) => {
          console.error('[Server] ESP32 WS error:', err.message)
        })

        this.sendToEsp({
          type: 'status',
          message: 'Connected to server',
        })
      })

      this.httpServer.listen(this.options.port, () => {
        console.log(
          `[Server] Listening on port ${this.options.port}`,
        )
        console.log(
          `[Server] Health check: http://localhost:${this.options.port}/health`,
        )
        resolve()
      })
    })
  }

  stop(): void {
    this.tts.disconnect()
    this.asr.disconnect()
    this.wss.close()
    this.httpServer.close()
  }

  // --- ASR→TTS pipeline ---

  private async triggerTts(text: string): Promise<void> {
    // Skip duplicate synthesis for the same text
    if (text === this.lastFinalAsrText) return
    this.lastFinalAsrText = text

    if (this.ttsSynthesizing) {
      console.log('[Server] TTS already synthesizing, skipping')
      return
    }

    if (!this.tts.isConnected()) {
      console.log('[Server] TTS not connected, skipping')
      return
    }

    this.ttsSynthesizing = true
    this.oggChunks = []

    try {
      this.sendToEsp({
        type: 'tts_start',
        sample_rate: this.options.ttsSampleRate,
        channels: 1,
      })

      await this.tts.synthesize(text)
    } catch (err) {
      console.error('[Server] TTS synthesis error:', err)
      this.sendToEsp({ type: 'error', message: `TTS error: ${err}` })
      this.sendToEsp({ type: 'tts_end' })
      this.ttsSynthesizing = false
    }
  }

  // --- ESP32 message handling ---

  private handleEspMessage(data: Buffer): void {
    // Try JSON text frame first
    try {
      const str = data.toString()
      const msg: { type: string } = JSON.parse(str)

      switch (msg.type) {
        case 'asr_start':
          console.log('[Server] ESP32 ASR start')
          this.asrRecording = true
          this.lastFinalAsrText = ''
          // Ensure ASR session is ready
          if (!this.asr.isSessionActive() && this.asr.isConnected()) {
            this.asr.startSession().catch((err) => {
              console.error('[Server] ASR session start error:', err)
            })
          }
          break

        case 'asr_stop':
          console.log('[Server] ESP32 ASR stop')
          this.asrRecording = false
          this.asr
            .sendAudio(Buffer.alloc(0), true)
            .then(() => this.asr.finishSession())
            .catch((err) => {
              console.error('[Server] ASR finish session error:', err)
            })
          break

        case 'tts_request':
          console.log(`[Server] ESP32 TTS request: "${(msg as any).text}"`)
          this.lastFinalAsrText = '' // allow repeated same text for testing
          this.triggerTts((msg as any).text || '测试语音')
          break

        case 'ping':
          this.sendToEsp({ type: 'pong' })
          break

        default:
          console.warn('[Server] Unknown ESP message type:', msg.type)
          break
      }
      return
    } catch {
      // Not JSON — treat as binary PCM audio
    }

    // Binary PCM audio → ASR
    if (this.asrRecording) {
      this.asr.sendAudio(data).catch((err) => {
        console.error('[Server] ASR send error:', err)
      })
    }
  }

  // --- ESP32 helpers ---

  private sendToEsp(msg: Record<string, unknown>): void {
    if (
      this.esp32Ws &&
      this.esp32Ws.readyState === WebSocket.OPEN
    ) {
      this.esp32Ws.send(JSON.stringify(msg))
    }
  }

  private saveRecording(sessionId: string): void {
    if (this.oggChunks.length === 0) return

    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true })
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `tts_${ts}_${sessionId.slice(0, 8)}.ogg`
    const filepath = path.join(this.recordingsDir, filename)

    const data = Buffer.concat(this.oggChunks)
    fs.writeFileSync(filepath, data)
    console.log(`[Server] Recording saved: ${filepath} (${data.length} bytes)`)
    this.oggChunks = []
  }
}
