/**
 * What a file REALLY is, from its first bytes: the extension and the declared content type are
 * never trusted. Only the three formats the shop accepts as uploads are recognised; everything
 * else (SVG, which can carry script, GIF, HEIC, PDF, an HTML page renamed `.jpg`) is `null`.
 */
export type ImageKind = 'jpeg' | 'png' | 'webp';

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  ) {
    return 'png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}
