/**
 * A minimal store-only zip writer.
 *
 * Hand-rolled on purpose. A zip library would be the obvious call, but this
 * extension's entire trust argument is that it has no dependencies to audit —
 * and store-only zip is about eighty lines. Deflate buys nothing here either:
 * the payload is mostly already-compressed images, and the importer does not
 * care.
 */

interface PendingEntry {
  readonly name: Uint8Array
  readonly crc: number
  readonly size: number
  readonly offset: number
}

const localHeaderSignature = 0x04034b50
const centralHeaderSignature = 0x02014b50
const endOfDirectorySignature = 0x06054b50
const localHeaderBytes = 30
const centralHeaderBytes = 46
const endOfDirectoryBytes = 22
const versionNeeded = 20
const utf8NameFlag = 0x0800
const storedMethod = 0
/** Entry count is a 16-bit field; beyond this the archive would need ZIP64. */
const maxEntries = 0xffff

/** Standard CRC-32, built once. */
const crcTable: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    const nextByte = bytes[index] ?? 0
    value = (crcTable[(value ^ nextByte) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

export class ZipArchive {
  private readonly parts: Uint8Array[] = []
  private readonly directory: PendingEntry[] = []
  private offset = 0
  private readonly encoder = new TextEncoder()

  get entryCount(): number {
    return this.directory.length
  }

  addText(path: string, contents: string): void {
    this.addBytes(path, this.encoder.encode(contents))
  }

  addJson(path: string, value: unknown): void {
    this.addText(path, JSON.stringify(value))
  }

  addBytes(path: string, data: Uint8Array): void {
    if (this.directory.length >= maxEntries) {
      throw new Error('too many entries for a non-ZIP64 archive')
    }

    const name = this.encoder.encode(path)
    const crc = crc32(data)
    const header = new DataView(new ArrayBuffer(localHeaderBytes))

    header.setUint32(0, localHeaderSignature, true)
    header.setUint16(4, versionNeeded, true)
    header.setUint16(6, utf8NameFlag, true)
    header.setUint16(8, storedMethod, true)
    header.setUint32(14, crc, true)
    header.setUint32(18, data.length, true)
    header.setUint32(22, data.length, true)
    header.setUint16(26, name.length, true)

    this.parts.push(new Uint8Array(header.buffer), name, data)
    this.directory.push({ name, crc, size: data.length, offset: this.offset })
    this.offset += localHeaderBytes + name.length + data.length
  }

  toBlob(): Blob {
    const directoryStart = this.offset
    let cursor = this.offset

    for (const entry of this.directory) {
      const header = new DataView(new ArrayBuffer(centralHeaderBytes))
      header.setUint32(0, centralHeaderSignature, true)
      header.setUint16(4, versionNeeded, true)
      header.setUint16(6, versionNeeded, true)
      header.setUint16(8, utf8NameFlag, true)
      header.setUint16(10, storedMethod, true)
      header.setUint32(16, entry.crc, true)
      header.setUint32(20, entry.size, true)
      header.setUint32(24, entry.size, true)
      header.setUint16(28, entry.name.length, true)
      header.setUint32(42, entry.offset, true)

      this.parts.push(new Uint8Array(header.buffer), entry.name)
      cursor += centralHeaderBytes + entry.name.length
    }

    const end = new DataView(new ArrayBuffer(endOfDirectoryBytes))
    end.setUint32(0, endOfDirectorySignature, true)
    end.setUint16(8, this.directory.length, true)
    end.setUint16(10, this.directory.length, true)
    end.setUint32(12, cursor - directoryStart, true)
    end.setUint32(16, directoryStart, true)
    this.parts.push(new Uint8Array(end.buffer))

    return new Blob(this.parts as BlobPart[], { type: 'application/zip' })
  }
}
