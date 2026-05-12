#!/usr/bin/env ts-node

import { Command } from 'commander'
import * as dotenv from 'dotenv'
import { LocalServer } from '../server/local_server'

dotenv.config()

function voiceToResourceId(voice: string): string {
  if (voice.startsWith('S_')) {
    return 'volc.megatts.default'
  }
  return 'volc.service_type.10029'
}

const program = new Command()

program
  .name('esp32-volc-bridge')
  .description(
    'Local server bridging ESP32 firmware and Volcengine cloud APIs (ASR + TTS)',
  )
  .option('--port <port>', 'HTTP server port', '3000')
  .option(
    '--appid <appid>',
    'Volcengine APP ID',
    process.env.VOLC_APP_ID || '',
  )
  .option(
    '--access_token <token>',
    'Volcengine Access Token',
    process.env.VOLC_ACCESS_TOKEN || '',
  )
  .option(
    '--asr_resource_id <id>',
    'ASR resource ID',
    process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',
  )
  .option(
    '--tts_resource_id <id>',
    'TTS resource ID',
    process.env.VOLC_TTS_RESOURCE_ID || '',
  )
  .option(
    '--voice_type <voice>',
    'Default voice type',
    process.env.VOLC_VOICE_TYPE || 'zh_female_shuangkuaisisi_moon_bigtts',
  )
  .option(
    '--sample_rate <rate>',
    'TTS output sample rate',
    '24000',
  )
  .option('--no-reconnect', 'Disable auto-reconnect to cloud services')
  .action(async (options) => {
    const ttsResourceId =
      (options.tts_resource_id || '').trim() ||
      voiceToResourceId(options.voice_type)

    console.log('=== ESP32 Volcengine Bridge Server ===')
    console.log(`Port:           ${options.port}`)
    console.log(`Voice:          ${options.voice_type}`)
    console.log(`ASR Resource:   ${options.asr_resource_id}`)
    console.log(`TTS Resource:   ${ttsResourceId}`)
    console.log(`TTS SampleRate: ${options.sample_rate}`)
    console.log(`Auto Reconnect: ${options.reconnect}`)
    console.log('')

    const server = new LocalServer({
      port: parseInt(options.port, 10),
      appId: options.appid,
      accessToken: options.access_token,
      asrResourceId: options.asr_resource_id,
      ttsResourceId,
      voiceType: options.voice_type,
      ttsSampleRate: parseInt(options.sample_rate, 10),
    })

    await server.start()

    // Graceful shutdown
    const shutdown = () => {
      console.log('\n[Server] Shutting down...')
      server.stop()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

program.parse()
