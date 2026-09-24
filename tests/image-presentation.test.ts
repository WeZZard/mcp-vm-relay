import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { IMAGE_PRESENTATION_POLICY, prepareImage, PresentationUnavailableError } from '../src/image-presentation.js';

// The JPEG and WebP fixtures are the 90x60 spatial PNG below, encoded once by a
// test-only codec outside this repository and committed; the core has no codec.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes: Buffer): number {
 let crc = 0xffffffff;
 for (const byte of bytes) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
 }
 return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
 const out = Buffer.alloc(12 + data.length);
 out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
 out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
 return out;
}
function header(width: number, height: number, depth = 8, colorType = 6): Buffer {
 const data = Buffer.alloc(13); data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
 data[8] = depth; data[9] = colorType;
 return chunk('IHDR', data);
}
/** Unequal thirds: red top-left, green top-right, blue bottom-left, yellow bottom-right. */
const quadrant = (x: number, y: number, width: number, height: number): [number, number, number] => {
 const right = x >= width / 3, bottom = y >= height * 2 / 3;
 return [right === bottom ? 255 : 0, right ? 255 : 0, bottom && !right ? 255 : 0];
};
function png(width: number, height: number, noise = false): Buffer {
 const raw = Buffer.alloc((width * 4 + 1) * height);
 let seed = 42;
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const offset = y * (width * 4 + 1) + 1 + x * 4;
  if (noise) {
   for (let c = 0; c < 3; c++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[offset + c] = seed & 255; }
  } else {
   const [r, g, b] = quadrant(x, y, width, height);
   raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
  }
  raw[offset + 3] = 255;
 }
 return Buffer.concat([signature, header(width, height), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function encoded(format: 'jpeg' | 'webp'): Buffer { return fixture(format === 'jpeg' ? 'spatial-90x60.jpg' : 'spatial-90x60.webp'); }
/** A test-side PNG reader for what the presenter emits (8-bit RGB or RGBA, non-interlaced), independent of the production decoder. */
function decode(bytes: Buffer): { width: number; height: number; channels: number; pixel(x: number, y: number): number[] } {
 assert.deepEqual(bytes.subarray(0, 8), signature);
 const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], colorType = bytes[25];
 assert.equal(depth, 8); assert.ok(colorType === 2 || colorType === 6); assert.equal(bytes[28], 0);
 const channels = colorType === 2 ? 3 : 4, stride = width * channels;
 const idat: Buffer[] = [];
 for (let offset = 8; offset < bytes.length;) {
  const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
  if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
  offset += 12 + length;
 }
 const raw = inflateSync(Buffer.concat(idat));
 assert.equal(raw.length, (stride + 1) * height);
 const out = Buffer.alloc(stride * height);
 for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  for (let i = 0; i < stride; i++) {
   const x = raw[y * (stride + 1) + 1 + i], a = i >= channels ? out[y * stride + i - channels] : 0, b = y ? out[(y - 1) * stride + i] : 0, c = y && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
   const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
   out[y * stride + i] = (x + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]) & 255;
  }
 }
 return { width, height, channels, pixel: (x, y) => Array.from(out.subarray((y * width + x) * channels, (y * width + x) * channels + 3)) };
}
function assertSpatial(bytes: Buffer, width: number, height: number): void {
 const image = decode(bytes);
 assert.equal(image.width, width); assert.equal(image.height, height);
 for (const [xf, yf, expected] of [
  [0.1, 0.1, [255, 0, 0]], [0.8, 0.1, [0, 255, 0]],
  [0.1, 0.9, [0, 0, 255]], [0.8, 0.9, [255, 255, 0]],
 ] as const) {
  const actual = image.pixel(Math.floor(xf * width), Math.floor(yf * height));
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[c] - expected[c]) < 20, `${xf},${yf}: ${actual}`);
 }
}
async function unavailable(bytes: Buffer, mime = 'image/png', message?: RegExp): Promise<void> {
 await assert.rejects(prepareImage(bytes, mime), error => {
  assert.ok(error instanceof PresentationUnavailableError);
  assert.equal(error.code, 'presentation-unavailable');
  if (message) assert.match(error.message, message);
  return true;
 });
}

test('spatial PNG returns a typed image, exact bytes, and presentation identity without mutating the original', async () => {
 const original = png(90, 60), copy = Buffer.from(original);
 const result = await prepareImage(original, 'image/png');
 assert.equal(result.content.type, 'image'); assert.equal(result.content.mimeType, 'image/png');
 assert.equal(result.content.data, original.toString('base64'));
 assert.deepEqual(result.presentation, {
  originalWidth: 90, originalHeight: 60, width: 90, height: 60, mimeType: 'image/png',
  sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length,
  transformed: false, policy: IMAGE_PRESENTATION_POLICY,
 });
 assert.deepEqual(original, copy);
 assertSpatial(Buffer.from(result.content.data, 'base64'), 90, 60);
});

test('an oversized PNG is resampled in-process within both dimensions, keeps its layout, and retains the original', async () => {
 const original = png(2400, 2100), copy = Buffer.from(original);
 const result = await prepareImage(original, 'image/png');
 assert.equal(result.presentation.originalWidth, 2400); assert.equal(result.presentation.originalHeight, 2100);
 assert.equal(result.presentation.width, 2000); assert.equal(result.presentation.height, 1750);
 assert.equal(result.presentation.transformed, true); assert.equal(result.presentation.mimeType, 'image/png');
 const delivered = Buffer.from(result.content.data, 'base64');
 assert.equal(result.presentation.sha256, createHash('sha256').update(delivered).digest('hex'));
 assert.equal(result.presentation.bytes, delivered.length);
 assert.ok(result.content.data.length <= 4 * 1024 * 1024);
 assert.deepEqual(original, copy);
 assertSpatial(delivered, 2000, 1750);
 assert.equal(decode(delivered).channels, 3, 'a fully opaque preview is encoded as RGB');
});

test('the encoded-payload byte limit is enforced independently of dimensions by shrinking the preview', async () => {
 const original = png(1200, 1200, true), copy = Buffer.from(original);
 assert.ok(original.toString('base64').length > IMAGE_PRESENTATION_POLICY.maxBytes);
 const result = await prepareImage(original, 'image/png');
 assert.ok(result.content.data.length <= IMAGE_PRESENTATION_POLICY.maxBytes);
 assert.equal(result.presentation.transformed, true);
 assert.ok(result.presentation.width <= 1200 && result.presentation.height <= 1200);
 assert.equal(result.presentation.width, result.presentation.height);
 assert.deepEqual(original, copy);
});

test('every PNG colour type and depth the header admits decodes to the same layout when resampled', async () => {
 const width = 2001, height = 3;
 const raster = (channels: number, depth: number, pixel: (x: number, y: number) => number[]) => {
  const stride = Math.ceil(width * channels * depth / 8), raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
   const samples = pixel(x, y);
   for (let c = 0; c < channels; c++) {
    if (depth === 8) raw[y * (stride + 1) + 1 + x * channels + c] = samples[c];
    else if (depth === 16) raw.writeUInt16BE(samples[c] * 257, y * (stride + 1) + 1 + (x * channels + c) * 2);
    else { const bit = (x * channels + c) * depth, index = y * (stride + 1) + 1 + (bit >> 3); raw[index] |= samples[c] << (8 - depth - (bit & 7)); }
   }
  }
  return raw;
 };
 const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
 const index = (x: number, y: number) => { const [r, g, b] = quadrant(x, y, width, height); return r && g ? 3 : r ? 0 : g ? 1 : 2; };
 const gray = (x: number, y: number) => quadrant(x, y, width, height)[0];
 const cases: Array<[string, Buffer, (x: number, y: number) => number[]]> = [
  ['rgba16', Buffer.concat([signature, header(width, height, 16, 6), chunk('IDAT', deflateSync(raster(4, 16, (x, y) => [...quadrant(x, y, width, height), 255]))), chunk('IEND', Buffer.alloc(0))]), (x, y) => quadrant(x, y, width, height)],
  ['rgb8', Buffer.concat([signature, header(width, height, 8, 2), chunk('IDAT', deflateSync(raster(3, 8, (x, y) => quadrant(x, y, width, height)))), chunk('IEND', Buffer.alloc(0))]), (x, y) => quadrant(x, y, width, height)],
  ['palette2', Buffer.concat([signature, header(width, height, 2, 3), chunk('PLTE', palette), chunk('IDAT', deflateSync(raster(1, 2, (x, y) => [index(x, y)]))), chunk('IEND', Buffer.alloc(0))]), (x, y) => quadrant(x, y, width, height)],
  ['gray1', Buffer.concat([signature, header(width, height, 1, 0), chunk('IDAT', deflateSync(raster(1, 1, (x, y) => [gray(x, y) ? 1 : 0]))), chunk('IEND', Buffer.alloc(0))]), (x, y) => { const g = gray(x, y); return [g, g, g]; }],
  ['grayalpha8', Buffer.concat([signature, header(width, height, 8, 4), chunk('IDAT', deflateSync(raster(2, 8, (x, y) => [gray(x, y), 128]))), chunk('IEND', Buffer.alloc(0))]), (x, y) => { const g = gray(x, y); return [g, g, g]; }],
 ];
 for (const [name, original, expected] of cases) {
  const result = await prepareImage(original, 'image/png');
  assert.equal(result.presentation.width, 2000, name); assert.equal(result.presentation.height, 3, name);
  const image = decode(Buffer.from(result.content.data, 'base64'));
  assert.equal(image.channels, name === 'grayalpha8' ? 4 : 3, name);
  for (const x of [100, 1500]) for (const y of [0, 2]) {
   const actual = image.pixel(x, y), want = expected(Math.round(x * width / 2000), y);
   for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[c] - want[c]) < 20, `${name} at ${x},${y}: ${actual} vs ${want}`);
  }
 }
});

for (const format of ['jpeg', 'webp'] as const) test(`a valid ${format} within the preview bounds passes through unchanged`, async () => {
 const original = encoded(format), result = await prepareImage(original, `image/${format}`);
 assert.equal(result.presentation.width, 90); assert.equal(result.presentation.height, 60);
 assert.equal(result.presentation.transformed, false);
 assert.equal(result.content.data, original.toString('base64'));
 assert.equal(result.content.mimeType, `image/${format}`);
});

test('a JPEG or WebP beyond the preview bounds is presentation-unavailable: only PNG is resampled here', async () => {
 const jpeg = encoded('jpeg');
 const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0])); assert.ok(frame > 0);
 const wide = Buffer.from(jpeg); wide.writeUInt16BE(2001, frame + 7);
 await unavailable(wide, 'image/jpeg', /only PNG originals are resampled/);
 const webp = encoded('webp'), lossless = webp.indexOf('VP8L'); assert.ok(lossless > 0);
 const tall = Buffer.from(webp); tall.writeUInt32LE((tall.readUInt32LE(lossless + 9) & ~(0x3fff << 14)) | (2000 << 14), lossless + 9);
 await unavailable(tall, 'image/webp', /only PNG originals are resampled/);
 assert.deepEqual(IMAGE_PRESENTATION_POLICY.resampledMimeTypes, ['image/png']);
 assert.equal(IMAGE_PRESENTATION_POLICY.dimensionSpace, 'stored');
});

test('rejects unsupported and mismatched MIME types', async () => {
 const original = png(3, 2);
 for (const mime of ['image/gif', 'image/svg+xml', 'image/tiff', 'image/jpg', 'image/png; charset=utf-8', 'IMAGE/PNG', 'text/plain']) {
  await unavailable(original, mime, /Unsupported image MIME/);
 }
 await unavailable(original, 'image/jpeg', /JPEG/);
 await unavailable(original, 'image/webp', /WebP/);
 await unavailable(encoded('jpeg'), 'image/png', /PNG/);
});

test('rejects empty and over-64-MiB originals before processing', async () => {
 await unavailable(Buffer.alloc(0), 'image/png', /64 MiB/);
 await unavailable(Buffer.alloc(64 * 1024 * 1024 + 1), 'image/png', /64 MiB/);
});

test('rejects truncated, corrupt and malformed PNG containers and payloads', async () => {
 const original = png(3, 2);
 for (const length of [1, 8, 16, 32, original.length - 1]) await unavailable(original.subarray(0, length));
 const corrupt = Buffer.from(original); corrupt[29] ^= 1; await unavailable(corrupt, 'image/png', /checksum/);
 const overflowing = Buffer.from(original); overflowing.writeUInt32BE(0xffffffff, 33); await unavailable(overflowing, 'image/png', /Truncated/);
 await unavailable(Buffer.concat([signature, header(3, 2), header(3, 2), original.subarray(33)]), 'image/png', /Duplicate/);
 await unavailable(Buffer.concat([original, Buffer.from([0])]), 'image/png', /end/);
 await unavailable(Buffer.concat([signature, header(3, 2), chunk('IDAT', Buffer.from('not zlib')), chunk('IEND', Buffer.alloc(0))]), 'image/png', /could not be decoded/);
 // Pixel data is decoded even when no resampling is needed: a short payload never passes through.
 await unavailable(Buffer.concat([signature, header(3, 2), chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND', Buffer.alloc(0))]), 'image/png', /could not be decoded/);
 await unavailable(Buffer.concat([signature, header(3, 2, 8, 3), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND', Buffer.alloc(0))]), 'image/png', /palette/);
 const interlaced = Buffer.from(png(2001, 2)); interlaced[28] = 1; interlaced.writeUInt32BE(crc32(interlaced.subarray(12, 29)), 29);
 await unavailable(interlaced, 'image/png', /Interlaced/);
});

test('bounds PNG dimensions before calling a pixel decoder, including zero and decompression-bomb headers', async () => {
 for (const [width, height] of [[0, 1], [1, 0], [32769, 1], [1, 32769], [10000, 10000], [0xffffffff, 0xffffffff]]) {
  await unavailable(Buffer.concat([signature, header(width, height)]), 'image/png', /dimensions|limits/);
 }
});

test('rejects animated PNG before decoding', async () => {
 const original = png(3, 2);
 for (const type of ['acTL', 'fcTL', 'fdAT']) {
  await unavailable(Buffer.concat([original.subarray(0, 33), chunk(type, Buffer.alloc(10)), original.subarray(33)]), 'image/png', /unsupported/);
 }
});

test('accepts compressed ancillary metadata (macOS captures carry iCCP and iTXt) without inflating it', async () => {
 const original = png(3, 2);
 for (const type of ['iCCP', 'zTXt', 'iTXt']) {
  const prepared = await prepareImage(Buffer.concat([original.subarray(0, 33), chunk(type, Buffer.from('not zlib at all')), original.subarray(33)]), 'image/png');
  assert.equal(prepared.presentation.width, 3);
 }
});

test('rejects malformed and oversized JPEG frame headers', async () => {
 const original = encoded('jpeg');
 await unavailable(original.subarray(0, -2), 'image/jpeg', /end/);
 const overflow = Buffer.from(original); overflow.writeUInt16BE(65535, 4); await unavailable(overflow, 'image/jpeg', /length/);
 const frame = original.indexOf(Buffer.from([0xff, 0xc0])); assert.ok(frame > 0);
 const bomb = Buffer.from(original); bomb.writeUInt16BE(20000, frame + 5); bomb.writeUInt16BE(20000, frame + 7);
 await unavailable(bomb, 'image/jpeg', /limits/);
 const zero = Buffer.from(original); zero.writeUInt16BE(0, frame + 5); await unavailable(zero, 'image/jpeg', /dimensions/);
 const duplicate = Buffer.concat([original.subarray(0, frame), original.subarray(frame, frame + 2 + original.readUInt16BE(frame + 2)), original.subarray(frame)]);
 await unavailable(duplicate, 'image/jpeg', /duplicate/);
});

function webpChunk(type: string, data: Buffer): Buffer {
 const out = Buffer.alloc(8 + data.length + (data.length & 1)); out.write(type); out.writeUInt32LE(data.length, 4); data.copy(out, 8); return out;
}
function webp(...chunks: Buffer[]): Buffer {
 const data = Buffer.concat(chunks), out = Buffer.alloc(12); out.write('RIFF'); out.writeUInt32LE(data.length + 4, 4); out.write('WEBP', 8);
 return Buffer.concat([out, data]);
}

test('rejects malformed, animated and oversized WebP canvas/frame headers', async () => {
 const original = encoded('webp');
 await unavailable(original.subarray(0, -1), 'image/webp', /length/);
 const badLength = Buffer.from(original); badLength.writeUInt32LE(0xffffffff, 16); await unavailable(badLength, 'image/webp', /Truncated/);
 const extended = Buffer.alloc(10); extended.writeUIntLE(9999, 4, 3); extended.writeUIntLE(9999, 7, 3);
 await unavailable(webp(webpChunk('VP8X', extended)), 'image/webp', /limits/);
 extended.fill(0); extended[0] = 2;
 await unavailable(webp(webpChunk('VP8X', extended)), 'image/webp', /animated/);
 await unavailable(webp(webpChunk('ANIM', Buffer.alloc(6))), 'image/webp', /Animated/);
 const lossless = Buffer.alloc(5); lossless[0] = 0x2f; lossless.writeUInt32LE(9999 | (9999 << 14), 1);
 await unavailable(webp(webpChunk('VP8L', lossless)), 'image/webp', /limits/);
 const lossy = Buffer.alloc(10); Buffer.from([0x9d, 1, 0x2a]).copy(lossy, 3); lossy.writeUInt16LE(9999, 6); lossy.writeUInt16LE(9999, 8);
 await unavailable(webp(webpChunk('VP8 ', lossy)), 'image/webp', /limits/);
 extended.fill(0); extended[4] = 9; extended[7] = 9;
 await unavailable(webp(webpChunk('VP8X', extended), ...[original.subarray(12)]), 'image/webp', /inconsistent/);
});

test('rejects excessive container records before decoding', async () => {
 const original = png(3, 2);
 const padding = Array.from({ length: IMAGE_PRESENTATION_POLICY.maxContainerRecords }, () => chunk('tEXt', Buffer.from('k\0v')));
 await unavailable(Buffer.concat([original.subarray(0, 33), ...padding, original.subarray(33)]), 'image/png', /chunk structure/);
});

test('WebP pixel data is not decoded in this core: a bounded header with unverified compressed pixels passes through, as the policy states', async () => {
 const lossless = Buffer.from([0x2f, 0, 0, 0, 0]);
 const result = await prepareImage(webp(webpChunk('VP8L', lossless)), 'image/webp');
 assert.equal(result.presentation.transformed, false); assert.equal(result.presentation.width, 1); assert.equal(result.presentation.height, 1);
 assert.equal(IMAGE_PRESENTATION_POLICY.resampledMimeTypes.includes('image/webp' as never), false);
});

test('JPEG EXIF orientation is not applied: stored dimensions are reported and the archived bytes are unchanged', async () => {
 const jpeg = encoded('jpeg');
 const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
 const app1 = Buffer.alloc(exif.length + 4); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(exif.length + 2, 2); exif.copy(app1, 4);
 const original = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]), copy = Buffer.from(original);
 const result = await prepareImage(original, 'image/jpeg');
 assert.equal(result.presentation.originalWidth, 90); assert.equal(result.presentation.originalHeight, 60);
 assert.equal(result.presentation.width, 90); assert.equal(result.presentation.height, 60);
 assert.equal(result.presentation.policy.dimensionSpace, 'stored');
 assert.equal(result.content.data, original.toString('base64'));
 assert.deepEqual(original, copy);
});

test('caller mutation after invocation cannot change the validated snapshot', async () => {
 const original = png(9, 6), saved = Buffer.from(original);
 const pending = prepareImage(original, 'image/png'); original.fill(0);
 const result = await pending;
 assert.equal(result.content.data, saved.toString('base64'));
});
