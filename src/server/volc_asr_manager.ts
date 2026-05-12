import WebSocket from 'ws'
import * as uuid from 'uuid'
import {
  AudioOnlyClient,
  StartConnection,
  FinishConnection,
  StartSession,
  FinishSession,
  ReceiveMessage,
  WaitForEvent,
  MsgType,
  MsgTypeFlagBits,
  EventType,
} from '../protocols'

export interface AsrCallbacks {
  onResult: (text: string, isFinal: boolean) => void
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

export class VolcAsrManager {
  private ws: WebSocket | null = null
  private callbacks: AsrCallbacks | null = null
  private state: State = State.Disconnected
  private sessionId: string | null = null
  private stopping = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Promise resolvers for session lifecycle — resolved by background receiver
  private sessionStartResolve:
    | ((value: void) => void)
    | null = null
  private sessionStartReject: ((err: Error) => void) | null = null
  private sessionFinishResolve: (() => void) | null = null

  private appId: string
  private accessToken: string
  private resourceId: string
  private endpoint: string
  private autoReconnect: boolean

  constructor(
    appId: string,
    accessToken: string,
    resourceId: string,
    autoReconnect = true,
    endpoint?: string,
  ) {
    this.appId = appId
    this.accessToken = accessToken
    this.resourceId = resourceId
    this.autoReconnect = autoReconnect
    this.endpoint =
      endpoint ||
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
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
        console.error(`[ASR] WS error: ${err.message}`)
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

      // Protocol handshake
      await StartConnection(this.ws)
      await WaitForEvent(
        this.ws,
        MsgType.FullServerResponse,
        EventType.ConnectionStarted,
      )

      this.state = State.Connected
      this.reconnectAttempts = 0
      console.log('[ASR] Connection established')

      this.startReceiver()
    } catch (err) {
      this.state = State.Disconnected
      console.error('[ASR] Connection failed:', err)
      if (!this.stopping && this.autoReconnect) {
        this.scheduleReconnect()
      }
      throw err
    }
  }

  async startSession(): Promise<void> {
    if (!this.ws || this.state === State.Disconnected) {
      throw new Error('ASR not connected')
    }

    if (this.state === State.SessionActive) {
      await this.finishSession()
    }

    this.sessionId = uuid.v4()

    const configPayload = JSON.stringify({
      user: { uid: uuid.v4() },
      audio: {
        format: 'wav',
        codec: 'raw',
        rate: 16000,
        bits: 16,
        channel: 1,
        language: 'zh-CN',
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        result_type: 'single',
        show_utterances: true,
      },
    })

    // Set up promise before sending — resolved by background receiver
    const sessionPromise = new Promise<void>((resolve, reject) => {
      this.sessionStartResolve = resolve
      this.sessionStartReject = reject
    })

    await StartSession(
      this.ws,
      new TextEncoder().encode(configPayload),
      this.sessionId,
    )

    // Wait for SessionStarted (or Error) from the receiver
    await sessionPromise

    this.state = State.SessionActive
    console.log('[ASR] Session started:', this.sessionId)
  }

  async sendAudio(pcmData: Buffer, isLast = false): Promise<void> {
    if (!this.ws || this.state !== State.SessionActive) {
      return // silently drop if not ready
    }
    const flag = isLast ? MsgTypeFlagBits.LastNoSeq : MsgTypeFlagBits.NoSeq
    await AudioOnlyClient(this.ws, new Uint8Array(pcmData), flag)
  }

  async finishSession(): Promise<void> {
    if (!this.ws || !this.sessionId) return
    if (this.state !== State.SessionActive) return

    this.stopping = true

    const finishPromise = new Promise<void>((resolve) => {
      this.sessionFinishResolve = resolve
    })

    await FinishSession(this.ws, this.sessionId)

    // Wait for SessionFinished from the receiver (with timeout)
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, 5000),
    )
    await Promise.race([finishPromise, timeout])

    this.state = State.Connected
    this.stopping = false
    this.sessionFinishResolve = null
    console.log('[ASR] Session finished:', this.sessionId)
    this.sessionId = null
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
          await this.finishSession()
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
    this.callbacks?.onStatus('ASR disconnected')
  }

  setCallbacks(cb: AsrCallbacks): void {
    this.callbacks = cb
  }

  isConnected(): boolean {
    return this.state === State.Connected || this.state === State.SessionActive
  }

  isSessionActive(): boolean {
    return this.state === State.SessionActive
  }

  // --- Private ---

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    this.callbacks?.onStatus(
      `ASR reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`,
    )
    console.log(`[ASR] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        // Reconnect will schedule another retry on close
      })
    }, delay)
  }

  private startReceiver(): void {
    if (!this.ws) return

    const loop = async () => {
      try {
        while (
          this.ws &&
          this.state !== State.Disconnected &&
          !this.stopping
        ) {
          const msg = await ReceiveMessage(this.ws)

          // Handle session lifecycle events first
          if (msg.event === EventType.SessionStarted) {
            if (this.sessionStartResolve) {
              this.sessionStartResolve()
              this.sessionStartResolve = null
              this.sessionStartReject = null
            }
            continue
          }

          if (msg.event === EventType.SessionFinished) {
            if (this.sessionFinishResolve) {
              this.sessionFinishResolve()
              this.sessionFinishResolve = null
            }
            continue
          }

          switch (msg.type) {
            case MsgType.FullServerResponse:
              if (msg.payload && msg.payload.length > 0) {
                const text = new TextDecoder().decode(msg.payload)
                try {
                  const result = JSON.parse(text)
                  if (result.payload_msg?.result) {
                    for (const r of result.payload_msg.result) {
                      if (r.text) {
                        this.callbacks?.onResult(r.text, r.is_final ?? false)
                      }
                    }
                  }
                  if (result.payload_msg?.utterances) {
                    for (const u of result.payload_msg.utterances) {
                      if (u.text) {
                        this.callbacks?.onResult(
                          u.text,
                          u.definite ?? false,
                        )
                      }
                    }
                  }
                } catch {
                  // Not JSON, skip
                }
              }
              break

            case MsgType.FrontEndResultServer:
              if (msg.payload && msg.payload.length > 0) {
                const text = new TextDecoder().decode(msg.payload)
                try {
                  const result = JSON.parse(text)
                  if (result.result?.text) {
                    this.callbacks?.onResult(
                      result.result.text,
                      result.result?.is_final ?? false,
                    )
                  }
                } catch {
                  // Not JSON, skip
                }
              }
              break

            case MsgType.Error: {
              const errCode = msg.errorCode ?? 'N/A'
              const errPayload = msg.payload?.length
                ? new TextDecoder().decode(msg.payload)
                : '(empty)'
              console.error(
                `[ASR] Error frame: code=${errCode}, payload=${errPayload}`,
              )
              // If we're waiting for a session start, the error is the server rejecting it
              if (this.sessionStartReject) {
                this.sessionStartReject(
                  new Error(
                    `ASR StartSession failed: code=${errCode}, payload=${errPayload}`,
                  ),
                )
                this.sessionStartResolve = null
                this.sessionStartReject = null
              }
              // Session timeout — server ended the session, reset state
              if (errCode === 45000081) {
                this.state = State.Connected
                this.sessionId = null
                console.log('[ASR] Session timed out (idle), reset to Connected')
              }
              break
            }

            default:
              break
          }
        }
      } catch (err) {
        if (!this.stopping) {
          console.error(`[ASR] Receive error: ${err}`)
        }
      }
    }

    loop()
  }
}
