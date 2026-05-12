/**
 * Minimal Ogg container demuxer — extracts raw Opus packets from an Ogg byte stream.
 *
 * Ogg page layout (RFC 3533):
 *   0-3:   "OggS"
 *   4:     version (0)
 *   5:     header_type  (1=continuation, 2=BOS, 4=EOS)
 *   6-13:  granule_position  (int64 LE)
 *   14-17: serial_number     (uint32 LE)
 *   18-21: page_sequence     (uint32 LE)
 *   22-25: checksum
 *   26:    page_segments (N)
 *   27..:  segment_table[N]
 *   then:  segment data  (sum of segment_table)
 *
 * Opus-in-Ogg: page 0 = "OpusHead" (BOS), page 1 = "OpusTags", pages 2+ = audio.
 */

const OGG_MAGIC = 0x4f676753 // "OggS"

export class OggDemuxer {
  private buf: Buffer
  private packetCount = 0

  constructor() {
    this.buf = Buffer.alloc(0)
  }

  feed(data: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, data])
    const packets: Buffer[] = []

    while (this.parseOnePage(packets)) {
      // keep going while pages are available
    }

    return packets
  }

  reset(): void {
    this.buf = Buffer.alloc(0)
    this.packetCount = 0
  }

  private parseOnePage(out: Buffer[]): boolean {
    if (this.buf.length < 27) return false

    const magic = this.buf.readUInt32BE(0)
    if (magic !== OGG_MAGIC) {
      const idx = this.buf.indexOf(Buffer.from('OggS'), 1)
      if (idx === -1) {
        this.buf = Buffer.alloc(0)
        return false
      }
      this.buf = this.buf.subarray(idx)
      if (this.buf.length < 27) return false
    }

    const headerType = this.buf[5]
    const pageSegments = this.buf[26]

    const headerEnd = 27 + pageSegments
    if (this.buf.length < headerEnd) return false

    const segmentTable = this.buf.subarray(27, headerEnd)
    let dataSize = 0
    for (let i = 0; i < pageSegments; i++) {
      dataSize += segmentTable[i]
    }

    const pageEnd = headerEnd + dataSize
    if (this.buf.length < pageEnd) return false

    const isBOS = (headerType & 0x02) !== 0
    const isEOS = (headerType & 0x04) !== 0

    if (!isBOS && !isEOS && dataSize > 0) {
      const segmentData = this.buf.subarray(headerEnd, pageEnd)
      let offset = 0

      let packetStart = 0
      for (let i = 0; i < pageSegments; i++) {
        const segLen = segmentTable[i]
        offset += segLen
        if (segLen < 255) {
          out.push(segmentData.subarray(packetStart, offset))
          this.packetCount++
          packetStart = offset
        }
      }
      if (packetStart < offset) {
        out.push(segmentData.subarray(packetStart, offset))
        this.packetCount++
      }
    }

    this.buf = this.buf.subarray(pageEnd)
    return true
  }
}
