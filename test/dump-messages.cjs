const fs = require('node:fs')
const zlib = require('node:zlib')

const file = process.argv[2]
const raw = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i)
}
let text = ''
for (let i = 0; i < starts.length; i += 1) {
  const from = starts[i]
  const to = i + 1 < starts.length ? starts[i + 1] : raw.length
  try {
    text += zlib.zstdDecompressSync(raw.subarray(from, to)).toString('utf8')
  } catch {}
}
const events = text.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line) } catch { return { type: 'unparsed', raw: line.slice(0, 200) } }
})
for (const event of events) {
  if (event.type !== 'user/message') continue
  const message = event.data?.message ?? event.data
  const source = message?.source
  const blocks = message?.content ?? []
  const preview = blocks
    .map((block) => (block.type === 'text' ? block.text : `<${block.type}>`))
    .join('')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  console.log(JSON.stringify({ seq: event.seq, source, preview }))
}
