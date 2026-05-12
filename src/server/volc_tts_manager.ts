import WebSocket from 'ws'
import * as uuid from 'uuid'
import {
  StartConnection,
  FinishConnection,
  StartSession,
  TaskRequest,
  FinishSession,
  CancelSession,
  ReceiveMessage,
  WaitForEvent,
  MsgType,
  EventType,
} from '../protocols'
import { OggDemuxer } from './ogg_demuxer'

export interface TtsCallbacks {
  onOpusPacket: (packet: Buffer) => void
  onOggPage: (page: Buffer) => void
  onSentenceStart: () => void
  onSentenceEnd: () => void
  onSessionFinished: (sessionId: string) => void
  onError: (error: string) => void
  onStatus: (status: string) => void
}

enum State {
  Disconnected = 'DISCONNECTED',
  Connecting = 'CONNECTING',
  Connected = 'CONNECTED',
  SessionActive = 'SESSION_ACTIVE',
  Disconnecting = 'DISCONNECTING',
}

export class VolcTtsManager {
  private ws: WebSocket | null = null
  private callbacks: TtsCallbacks | null = null
  private sessionId: string | null = null
  private demuxer = new OggDemuxer()
  private state: State = State.Disconnected
  private stopping = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private appId: string
  private accessToken: string
  private resourceId: string
  private voiceType: string
  private endpoint: string
  private autoReconnect: boolean

  constructor(
    appId: string,
    accessToken: string,
    resourceId: string,
    voiceType: string,
    autoReconnect = true,
    endpoint?: string,
  ) {
    this.appId = appId
    this.accessToken = accessToken
    this.resourceId = resourceId
    this.voiceType = voiceType
    this.autoReconnect = autoReconnect
    this.endpoint =
      endpoint || 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
  }

  async connect(): Promise<void> {
    if (this.state !== State.Disconnected) return

    this.state = State.Connecting
    this.stopping = false

    try {
      const headers = {
        'X-Api-App-Key': this.appId,
        'X-Api-Access-Key': this.accessToken,
        'X-Api-Resource-Id': this.resourceId,
        'X-Api-Connect-Id': uuid.v4(),
      }

      this.ws = new WebSocket(this.endpoint, {
        headers,
        skipUTF8Validation: true,
      })

      await new Promise<void>((resolve, reject) => {
        this.ws!.on('open', resolve)
        this.ws!.on('error', reject)
      })

      this.ws.on('error', (err) => {
        console.error(`[TTS] WS error: ${err.message}`)
      })

      this.ws.on('close', () => {
        const wasActive = this.state !== State.Disconnected
        this.state = State.Disconnected
        this.sessionId = null
        this.ws = null

        if (wasActive && !this.stopping && this.autoReconnect) {
          this.scheduleReconnect()
        }
      })

      await StartConnection(this.ws)
      await WaitForEvent(
        this.ws,
        MsgType.FullServerResponse,
        EventType.ConnectionStarted,
      )

      this.state = State.Connected
      this.reconnectAttempts = 0
      this.callbacks?.onStatus('TTS connected')
      console.log('[TTS] Connection established')
    } catch (err) {
      this.state = State.Disconnected
      console.error('[TTS] Connection failed:', err)
      if (!this.stopping && this.autoReconnect) {
        this.scheduleReconnect()
      }
      throw err
    }
  }

  /**
   * Synthesize a complete sentence. Handles the full session lifecycle:
   * startSession → stream text → receive audio → finishSession
   */
  async synthesize(text: string, voiceType?: string): Promise<void> {
    if (!this.ws || this.state === State.Disconnected) {
      throw new Error('TTS not connected')
    }
    if (this.state === State.SessionActive) {
      throw new Error('TTS session already active')
    }

    const voice = voiceType || this.voiceType
    this.sessionId = uuid.v4()
    this.demuxer.reset()

    // Start session
    const sessionPayload = JSON.stringify({
      user: { uid: uuid.v4() },
      req_params: {
        speaker: voice,
        audio_params: {
          format: 'ogg_opus',
          sample_rate: 24000,
          bit_rate: 32000,
          enable_timestamp: false,
        },
        namespace: 'BidirectionalTTS',
      },
    })

    await StartSession(
      this.ws,
      new TextEncoder().encode(sessionPayload),
      this.sessionId,
    )
    await WaitForEvent(
      this.ws,
      MsgType.FullServerResponse,
      EventType.SessionStarted,
    )

    this.state = State.SessionActive
    console.log(`[TTS] Session started: ${this.sessionId}`)
    this.callbacks?.onStatus(`TTS session started: ${this.sessionId}`)

    // Send complete text as single utterance, then receive audio
    const receivePromise = this.receiveAudioLoop()

    console.log(`[TTS] Sending text (${text.length} chars): "${text}"`)
    const payload = JSON.stringify({
      user: { uid: uuid.v4() },
      req_params: { text },
      namespace: 'BidirectionalTTS',
    })
    await TaskRequest(
      this.ws!,
      new TextEncoder().encode(payload),
      this.sessionId!,
    )

    await receivePromise

    // Finish session
    await this.finishSession()
  }

  async finishSession(): Promise<void> {
    if (!this.ws || !this.sessionId) return
    if (this.state !== State.SessionActive) return

    this.stopping = true
    await FinishSession(this.ws, this.sessionId)

    try {
      await WaitForEvent(
        this.ws,
        MsgType.FullServerResponse,
        EventType.SessionFinished,
      )
    } catch {
      // SessionFinished might already be received
    }

    this.state = State.Connected
    this.stopping = false
    this.callbacks?.onSessionFinished(this.sessionId!)
    console.log(`[TTS] Session finished: ${this.sessionId}`)
    this.sessionId = null
  }

  async cancelSession(): Promise<void> {
    if (!this.ws || !this.sessionId) return
    if (this.state !== State.SessionActive) return

    this.stopping = true
    await CancelSession(this.ws, this.sessionId)

    try {
      await WaitForEvent(
        this.ws,
        MsgType.FullServerResponse,
        EventType.SessionCanceled,
      )
    } catch {
      // Ignore
    }

    this.state = State.Connected
    this.stopping = false
    this.sessionId = null
    console.log('[TTS] Session canceled')
  }

  async disconnect(): Promise<void> {
    this.stopping = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws && this.state !== State.Disconnected) {
      try {
        if (this.state === State.SessionActive) {
          await this.cancelSession()
        }
        await FinishConnection(this.ws)
      } catch {
        // Ignore
      }

      this.ws.close()
    }

    this.state = State.Disconnected
    this.ws = null
    this.sessionId = null
    this.callbacks?.onStatus('TTS disconnected')
  }

  setCallbacks(cb: TtsCallbacks): void {
    this.callbacks = cb
  }

  isConnected(): boolean {
    return this.state === State.Connected || this.state === State.SessionActive
  }

  isSessionActive(): boolean {
    return this.state === State.SessionActive
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  // --- Private ---

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    this.callbacks?.onStatus(
      `TTS reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`,
    )
    console.log(
      `[TTS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        // Reconnect will schedule another retry on close
      })
    }, delay)
  }

  private async receiveAudioLoop(): Promise<void> {
    if (!this.ws) return

    let sentenceEnded = false

    try {
      while (!sentenceEnded && this.ws && !this.stopping) {
        const msg = await ReceiveMessage(this.ws)

        switch (msg.type) {
          case MsgType.FullServerResponse:
            if (msg.event === EventType.TTSSentenceStart) {
              this.callbacks?.onSentenceStart()
              console.log('[TTS] Sentence start')
            } else if (msg.event === EventType.TTSSentenceEnd) {
              sentenceEnded = true
              this.callbacks?.onSentenceEnd()
              console.log('[TTS] Sentence end')
            } else if (msg.event === EventType.SessionFinished) {
              this.state = State.Connected
              sentenceEnded = true
              console.log('[TTS] SessionFinished received')
            }
            break

          case MsgType.AudioOnlyServer:
            if (msg.payload && msg.payload.length > 0) {
              const oggPage = Buffer.from(msg.payload)
              this.callbacks?.onOggPage(oggPage)
              const opusPackets = this.demuxer.feed(oggPage)
              for (const packet of opusPackets) {
                this.callbacks?.onOpusPacket(packet)
              }
            }
            break

          case MsgType.Error: {
            const errCode = msg.errorCode ?? 'N/A'
            const errPayload = msg.payload?.length
              ? new TextDecoder().decode(msg.payload)
              : '(empty)'
            console.error(
              `[TTS] Error frame: code=${errCode}, payload=${errPayload}`,
            )
            break
          }

          default:
            break
        }
      }
    } catch (err) {
      if (!this.stopping) {
        this.callbacks?.onError(`TTS receive error: ${err}`)
      }
    }
  }
}
