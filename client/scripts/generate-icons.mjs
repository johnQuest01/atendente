// Gera ícones PNG do PWA (fundo roxo da marca com um "M" branco).
// Usa apenas módulos nativos do Node (zlib) — sem dependências externas.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../public/icons');

const BG = [0x6d, 0x4a, 0xff]; // #6D4AFF
const FG = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Desenha um "M" simples por pixels normalizados.
function isForeground(x, y, size) {
  const u = x / size;
  const v = y / size;
  if (u < 0.2 || u > 0.8 || v < 0.25 || v > 0.78) return false;
  const stroke = 0.1;
  // hastes verticais
  if (u < 0.2 + stroke) return true;
  if (u > 0.8 - stroke) return true;
  // diagonais que se encontram no centro
  const leftDiag = Math.abs(v - 0.25 - (u - 0.2) * 2.0) < stroke * 1.6 && u < 0.5;
  const rightDiag = Math.abs(v - 0.25 - (0.8 - u) * 2.0) < stroke * 1.6 && u >= 0.5;
  return leftDiag || rightDiag;
}

function buildPng(size) {
  const bytesPerPixel = 3;
  const rowLen = size * bytesPerPixel + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * rowLen] = 0; // filter none
    for (let x = 0; x < size; x += 1) {
      const color = isForeground(x, y, size) ? FG : BG;
      const off = y * rowLen + 1 + x * bytesPerPixel;
      raw[off] = color[0];
      raw[off + 1] = color[1];
      raw[off + 2] = color[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const png = buildPng(size);
  fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), png);
  console.log(`icon-${size}.png gerado (${png.length} bytes)`);
}
