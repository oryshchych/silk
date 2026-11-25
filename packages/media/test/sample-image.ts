import sharp from 'sharp';

/** A smooth, photo-like JPEG (a blurred noise field scaled up): hundreds of KB at 3000 px. */
export async function samplePhoto(width: number, height: number): Promise<Buffer> {
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
  return await sharp(noise)
    .resize(width, height, { kernel: 'cubic' })
    .blur(2)
    .jpeg({ quality: 92 })
    .toBuffer();
}
