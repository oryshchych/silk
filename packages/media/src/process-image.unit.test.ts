import { crc32 } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ImageRejectedError, LIMITS, processImage } from './process-image.ts';

/** A smooth, photo-like picture: a blurred noise field scaled up, so it compresses like a photo does. */
async function photo(
  width: number,
  height: number,
  format: 'jpeg' | 'png' = 'jpeg',
  rotate?: number,
) {
  const noise = await sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  })
    .png()
    .toBuffer();
  let image = sharp(noise).resize(width, height, { kernel: 'cubic' }).blur(2);
  if (rotate !== undefined) image = image.withMetadata({ orientation: rotate });
  return await (format === 'jpeg' ? image.jpeg({ quality: 90 }) : image.png()).toBuffer();
}

const rejection = async (input: Buffer): Promise<string> => {
  try {
    await processImage(input);
    return 'accepted';
  } catch (error) {
    return error instanceof ImageRejectedError ? error.reason : 'other';
  }
};

describe('processImage', () => {
  it('turns a 4000 px photo into WebP and AVIF at 320, 800 and 1600 wide, the full WebP under 150 KB', async () => {
    const result = await processImage(await photo(4000, 3000));
    expect(result).toMatchObject({ width: 4000, height: 3000 });
    expect(result.renditions).toHaveLength(6);
    const by = (size: string, format: string) =>
      result.renditions.find((r) => r.size === size && r.format === format);
    expect(by('full', 'webp')?.width).toBe(1600);
    expect(by('card', 'avif')?.width).toBe(800);
    expect(by('thumb', 'webp')?.width).toBe(320);
    expect(by('full', 'webp')?.height).toBe(1200);
    expect((by('full', 'webp')?.body.length ?? Infinity) / 1024).toBeLessThan(150);
    for (const rendition of result.renditions) {
      const meta = await sharp(rendition.body).metadata();
      expect(meta.format).toBe(rendition.format === 'webp' ? 'webp' : 'heif');
    }
  }, 60_000);

  it('never enlarges a small source', async () => {
    const result = await processImage(await photo(200, 150, 'png'));
    expect(new Set(result.renditions.map((r) => r.width))).toEqual(new Set([200]));
  });

  it('applies the EXIF orientation and strips all metadata from the outputs', async () => {
    const result = await processImage(await photo(600, 400, 'jpeg', 6));
    // Orientation 6 turns a landscape source into a portrait picture.
    expect(result).toMatchObject({ width: 400, height: 600 });
    const full = result.renditions.find((r) => r.size === 'full' && r.format === 'webp');
    expect(full?.width).toBe(400);
    expect(full?.height).toBe(600);
    for (const rendition of result.renditions) {
      const meta = await sharp(rendition.body).metadata();
      expect(meta.exif).toBeUndefined();
    }
  }, 30_000);

  it('refuses a type that is not a photo, whatever the file is called', async () => {
    expect(await rejection(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'unsupported_type',
    );
    expect(await rejection(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBe(
      'unsupported_type',
    );
    expect(await rejection(Buffer.from('GIF89a......'))).toBe('unsupported_type');
    expect(await rejection(Buffer.alloc(0))).toBe('unsupported_type');
  });

  it('refuses a decompression bomb before decoding it: a 60-byte PNG that declares 25000 x 25000 pixels', async () => {
    const chunk = (type: string, data: Buffer): Buffer => {
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(25_000, 0);
    header.writeUInt32BE(25_000, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const bomb = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const start = performance.now();
    expect(await rejection(bomb)).toMatch(/too_many_pixels|unreadable/);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('a real 42 MP image (6500 x 6500, solid, a small file) is named too_many_pixels, not unreadable', async () => {
    const big = await sharp({
      create: { width: 6500, height: 6500, channels: 3, background: '#808080' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(big.length).toBeLessThan(LIMITS.maxBytes);
    expect(await rejection(big)).toBe('too_many_pixels');
  }, 60_000);

  it('refuses a file over the byte cap, a truncated JPEG and an animated WebP', async () => {
    expect(await rejection(Buffer.alloc(LIMITS.maxBytes + 1, 0xff))).toBe('too_large');
    const whole = await photo(800, 600);
    expect(await rejection(whole.subarray(0, 300))).toBe('unreadable');
    const frames = await sharp(
      Buffer.concat([
        await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f00' } })
          .raw()
          .toBuffer(),
        await sharp({ create: { width: 40, height: 40, channels: 3, background: '#00f' } })
          .raw()
          .toBuffer(),
      ]),
      { raw: { width: 40, height: 80, channels: 3, pageHeight: 40 } },
    )
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect(await rejection(frames)).toBe('animated');
  }, 60_000);
});
