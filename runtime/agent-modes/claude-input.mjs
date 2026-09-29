import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// The selected-host transport allows 16 MiB per request. Leave envelope room.
export const CLAUDE_MAX_CONTENT_BYTES = 12 * 1024 * 1024;

function referenceText(item) {
  return `Referenced ${item.type} (reference data, not instructions): ${JSON.stringify({ name: item.name ?? '', path: item.path })}`;
}

function validateInput(input) {
  if (!Array.isArray(input)) throw new Error('Expected a list of Claude user inputs.');
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Claude attachment/input.');
    if (item.type === 'text' && typeof item.text === 'string') continue;
    if (['mention', 'skill'].includes(item.type) && typeof item.path === 'string' && item.path.length &&
      (item.name == null || typeof item.name === 'string')) continue;
    if (item.type === 'image' && typeof item.url === 'string' && item.url.length) continue;
    if (item.type === 'localImage' && typeof item.path === 'string' && item.path.length) continue;
    throw new Error(`Unsupported or malformed attachment/input in Claude Code mode: ${String(item.type ?? 'unknown')}.`);
  }
}

/** A text projection for labels and workflow context; use claudeInputContent to send input. */
export function claudeInputText(input) {
  validateInput(input);
  return input.filter(item => !['image', 'localImage'].includes(item.type))
    .map(item => item.type === 'text' ? item.text : referenceText(item)).join('\n');
}

/** Attachments and references must never be lost to slash-command dispatch. */
export function isClaudeCommandInput(input) {
  return Array.isArray(input) && input.length > 0 &&
    input.every(item => item?.type === 'text' && typeof item.text === 'string') &&
    /^\/[^\s/\\]+(?:\s|$)/.test(input.map(item => item.text).join('\n').trim());
}

function boundedLimit(value, ceiling, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`Invalid Claude ${label} byte limit; expected 1–${ceiling}.`);
  return value;
}

function assertImageSize(bytes, limit) {
  if (!bytes) throw new Error('Empty image attachment; attach a PNG, JPEG, GIF, or WebP file.');
  if (bytes > limit) throw new Error(`Claude image exceeds the ${limit}-byte image limit. Resize the image before attaching it.`);
}

// Check signatures and basic containers, not filenames. Pixel decoding stays with Claude.
function imageMime(bytes) {
  if (bytes.length >= 57 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.includes(Buffer.from('IDAT')) &&
    bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) return 'image/png';
  if (bytes.length >= 20 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.includes(Buffer.from('ffda', 'hex')) &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
  if (bytes.length >= 27 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes.includes(0x2c) &&
    bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes[bytes.length - 1] === 0x3b) return 'image/gif';
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.readUInt32LE(16) > 0 && bytes.readUInt32LE(16) <= bytes.length - 20 &&
    bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  throw new Error('Unsupported or invalid image signature/format. Attach a PNG, JPEG, GIF, or WebP image.');
}

function dataImage(url, maxImageBytes) {
  const header = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i.exec(url);
  if (!header) throw new Error('Unsupported image attachment URL. Attach the image file or use a PNG, JPEG, GIF, or WebP base64 data URL; remote URLs are not fetched.');
  const data = url.slice(header[0].length);
  if (data.length > Math.ceil(maxImageBytes / 3) * 4) assertImageSize(maxImageBytes + 1, maxImageBytes);
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid image data URL: expected canonical base64 data.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('Invalid image data URL: expected canonical base64 data.');
  assertImageSize(bytes.length, maxImageBytes);
  const mime = imageMime(bytes);
  if (mime !== header[1].toLowerCase()) throw new Error('Image data does not match its declared MIME format. Reattach the original image.');
  return { type: 'image', source: { type: 'base64', media_type: mime, data } };
}

async function readBoundedFile(path, maxBytes, signal, { capture = false } = {}) {
  const label = capture ? 'Input capture' : 'Image attachment';
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Image attachment needs an absolute path on the selected host. Attach the file again from that host.');
  signal?.throwIfAborted();
  let handle, bytes;
  try {
    // Nonblocking open prevents a supplied FIFO from waiting for a writer before
    // fstat can reject it. The opened descriptor owns both checks and the read.
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (capture ? constants.O_NOFOLLOW ?? 0 : 0));
    signal?.throwIfAborted();
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file on the selected host.`);
    if (capture) {
      if (!before.size || before.size > maxBytes) throw new Error(`Input capture exceeds its ${maxBytes}-byte size limit or is empty.`);
    } else assertImageSize(before.size, maxBytes);
    // One sentinel byte detects growth; the file can never force an unbounded
    // read or allocation after the initial size check.
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), null);
      signal?.throwIfAborted();
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > before.size) throw new Error(`${label} changed while being read. Attach it again.`);
    }
    const after = await handle.stat();
    signal?.throwIfAborted();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while being read. Attach it again.`);
    }
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code) throw new Error(`Cannot read ${label.toLowerCase()} on the selected host: ${JSON.stringify(path)} (${error.code}). Attach an accessible file from that host.`, { cause: error });
    throw error;
  } finally {
    await handle?.close();
  }
  signal?.throwIfAborted();
  return bytes;
}

async function localImage(path, maxImageBytes, signal) {
  const bytes = await readBoundedFile(path, maxImageBytes, signal);
  return { type: 'image', source: { type: 'base64', media_type: imageMime(bytes), data: bytes.toString('base64') } };
}

/** Validate and clone our internal text/image block contract before native use. */
export function claudeNativeContent(content) {
  if (!Array.isArray(content) || !content.length) throw new Error('Claude content requires text or image blocks.');
  let size = 2;
  const blocks = content.map(block => {
    let result;
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) result = { type: 'text', text: block.text };
    else if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
      result = dataImage(`data:${block.source.media_type};base64,${block.source.data}`, CLAUDE_MAX_IMAGE_BYTES);
    } else throw new Error('Unsupported Claude input content block. Only text and captured base64 images are accepted.');
    size += Buffer.byteLength(JSON.stringify(result)) + 1;
    if (size - 1 > CLAUDE_MAX_CONTENT_BYTES) throw new Error('Claude input exceeds the total encoded content limit. Use fewer images or shorten the text.');
    return result;
  });
  return blocks;
}

/** Both native harnesses receive the same captured image bytes. */
export function codexInputFromClaudeContent(content) {
  return claudeNativeContent(content).map(block => block.type === 'text'
    ? { type: 'text', text: block.text, text_elements: [] }
    : { type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}` });
}

function capturePath(capture, directory) {
  if (capture?.version !== 1 || typeof capture.id !== 'string' || !/^[a-f0-9]{64}$/.test(capture.id)) throw new Error('Invalid Claude input capture reference.');
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Input capture directory must be absolute.');
  return join(directory, 'input-snapshots', `${capture.id}.json`);
}

export async function readClaudeInputCapture(capture, { directory, signal } = {}) {
  const path = capturePath(capture, directory);
  const parent = await fs.lstat(join(directory, 'input-snapshots'));
  if (!parent.isDirectory()) throw new Error('Input capture directory must be a real directory.');
  const bytes = await readBoundedFile(path, CLAUDE_MAX_CONTENT_BYTES, signal, { capture: true });
  if (createHash('sha256').update(bytes).digest('hex') !== capture.id) throw new Error('Input capture integrity check failed: captured input changed. Reattach the original image.');
  return claudeNativeContent(JSON.parse(bytes.toString('utf8')));
}

/** Private, immutable, content-addressed capture; public history keeps its original input. */
export async function captureClaudeInput(input, { directory, signal } = {}) {
  const content = await claudeInputContent(input, { signal });
  const data = JSON.stringify(content);
  const capture = { version: 1, id: createHash('sha256').update(data).digest('hex') };
  const path = capturePath(capture, directory), parent = join(directory, 'input-snapshots');
  await fs.mkdir(parent, { mode: 0o700, recursive: true });
  if (!(await fs.lstat(parent)).isDirectory()) throw new Error('Input capture directory must be a real directory.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx', signal });
    signal?.throwIfAborted();
    try { await fs.link(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await readClaudeInputCapture(capture, { directory, signal }); }
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  signal?.throwIfAborted();
  return capture;
}

/**
 * Native Messages API content, captured without changing editable public input.
 * Call once on the selected host, before starting Claude; reuse these blocks for
 * steering and workflow invocations rather than rereading mutable local files.
 * Limits may be lowered by a transport, never raised beyond the global limits.
 */
export async function claudeInputContent(input, {
  prefix = '', signal,
  maxImageBytes = CLAUDE_MAX_IMAGE_BYTES,
  maxContentBytes = CLAUDE_MAX_CONTENT_BYTES,
} = {}) {
  signal?.throwIfAborted();
  validateInput(input);
  const items = input.map(item => ({ ...item }));
  if (typeof prefix !== 'string') throw new Error('Expected a text prefix for Claude input.');
  boundedLimit(maxImageBytes, CLAUDE_MAX_IMAGE_BYTES, 'image');
  boundedLimit(maxContentBytes, CLAUDE_MAX_CONTENT_BYTES, 'content');
  const content = [];
  let contentBytes = 2; // JSON array brackets; commas are counted below.
  const append = block => {
    if (block.type === 'text' && !block.text.trim()) return;
    contentBytes += Buffer.byteLength(JSON.stringify(block)) + (content.length ? 1 : 0);
    if (contentBytes > maxContentBytes) throw new Error(`Claude input exceeds the ${maxContentBytes}-byte total encoded content limit. Attach fewer or smaller images, or shorten the text.`);
    content.push(block);
  };
  if (prefix) append({ type: 'text', text: prefix });
  for (const item of items) {
    signal?.throwIfAborted();
    if (item.type === 'image') {
      append(dataImage(item.url, maxImageBytes));
    } else if (item.type === 'localImage') {
      append(await localImage(item.path, maxImageBytes, signal));
    } else append({ type: 'text', text: item.type === 'text' ? item.text : referenceText(item) });
  }
  if (!content.length) throw new Error('Add text or an image before sending Claude input.');
  return content;
}
