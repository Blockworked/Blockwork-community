/** Only small, static, 8-bit RGB/RGBA PNGs. Verify checksums and the bounded
 * decompressed raster; discard all ancillary chunks (including metadata). */
export async function cleanProfilePng(bytes: Uint8Array): Promise<Uint8Array> {
  const invalid = () => new Error('Choose a valid static PNG picture, up to 512 × 512 pixels and 256 KiB.');
  if (bytes.length > 262144 || bytes.length < 57 || ![137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep: Uint8Array[] = [bytes.slice(0,8)], data: Uint8Array[] = [];
  let offset = 8, width = 0, height = 0, channels = 0, ended = false, dataEnded = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset), end = offset + size + 12;
    if (end > bytes.length) throw invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) throw invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || size !== 13) throw invalid();
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16], color = bytes[offset + 17];
      if (!width || !height || width > 512 || height > 512 || depth !== 8 || ![2,6].includes(color) || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20]) throw invalid();
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      if (!width || dataEnded) throw invalid();
      data.push(bytes.slice(offset + 8, end - 4));
    } else if (type === 'IEND') {
      if (size || !data.length || end !== bytes.length) throw invalid();
      ended = true;
    } else {
      // Reject animation and unknown critical chunks; strip ancillary data.
      if (!/^[a-z][A-Za-z]{3}$/.test(type) || ['acTL','fcTL','fdAT'].includes(type)) throw invalid();
      if (data.length) dataEnded = true;
    }
    if (['IHDR','IDAT','IEND'].includes(type)) keep.push(bytes.slice(offset,end));
    offset = end;
  }
  if (!ended || offset !== bytes.length) throw invalid();
  const compressed = new Uint8Array(data.reduce((n,b) => n + b.length, 0));
  let p = 0; for (const b of data) { compressed.set(b,p); p += b.length; }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader(), stride = width * channels + 1, expected = stride * height;
  let count = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      if (count + value.length > expected) { await reader.cancel(); throw invalid(); }
      for (let i = (stride - count % stride) % stride; i < value.length; i += stride) if (value[i] > 4) throw invalid();
      count += value.length;
    }
  } catch { await reader.cancel().catch(() => {}); throw invalid(); }
  if (count !== expected) throw invalid();
  const output = new Uint8Array(keep.reduce((n,b) => n + b.length, 0));
  p = 0; for (const b of keep) { output.set(b,p); p += b.length; }
  return output;
}
