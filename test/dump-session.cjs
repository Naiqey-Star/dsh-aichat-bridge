const fs = require('node:fs')
const zlib = require('node:zlib')

const file = process.argv[2]
const tail = Number(process.argv[3] ?? 8)
const raw = fs.readFileSync(file)

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i)
}

let text = ''
for (let index = 0; index < starts.length; index += 1) {
  const from = starts[index]
  const to = index + 1 < starts.length ? starts[index + 1] : raw.length
  try {
    text += zlib.zstdDecompressSync(raw.subarray(from, to)).toString('utf8')
  } catch {
    // Not a self-contained frame; skip.
  }
}

if (text === '') {
  try {
    text = zlib.zstdDecompressSync(raw).toString('utf8')
  } catch (error) {
    console.error(`decode failed: ${error.message}`)
    process.exit(1)
  }
}

const lines = text.split('\n').filter(Boolean)
console.error(`frames=${starts.length} lines=${lines.length}`)
for (const line of lines.slice(-tail)) {
  try {
    const event = JSON.parse(line)
    console.log(JSON.stringify({ type: event.type, seq: event.seq, data: event.data }).slice(0, 1200))
  } catch {
    console.log(line.slice(0, 400))
  }
}
