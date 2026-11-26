/**
 * A photo as `<picture>`: AVIF and WebP at three widths with `sizes`, the original as the
 * fallback. Plain markup (no hooks), so server and client components both use it. `width` and
 * `height` are always set (the box is reserved: no layout shift); `priority` marks the LCP
 * candidate (`fetchpriority=high`, eager) and everything else loads lazily.
 *
 * `next/image` cannot express this: it would resize through the server, but the renditions
 * already exist in the bucket (CDN-cached), so the browser should pick one directly.
 */
import { renditionSources } from '../lib/renditions';

export interface ResponsiveImageProps {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** The `sizes` attribute: how wide the image is laid out at each viewport. */
  sizes: string;
  /** The LCP candidate: eager and `fetchpriority=high`. At most ONE per page. */
  priority?: boolean;
  /** Above the fold but not THE candidate: eager, no priority hint. */
  eager?: boolean;
  className?: string;
}

const FALLBACK_WIDTH = 800;
const FALLBACK_HEIGHT = 1000;

export function ResponsiveImage({
  url,
  alt,
  width,
  height,
  sizes,
  priority = false,
  eager = false,
  className,
}: ResponsiveImageProps) {
  const sources = renditionSources(url, width, height);
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- the renditions are pre-generated; a <picture> lets the browser choose one
    <img
      src={url}
      alt={alt}
      width={width ?? FALLBACK_WIDTH}
      height={height ?? FALLBACK_HEIGHT}
      sizes={sources === null ? undefined : sizes}
      loading={priority || eager ? 'eager' : 'lazy'}
      decoding="async"
      {...(priority ? { fetchPriority: 'high' as const } : {})}
      className={className}
    />
  );
  if (sources === null) return img;
  return (
    <picture>
      <source type="image/avif" srcSet={sources.avif} sizes={sizes} />
      <source type="image/webp" srcSet={sources.webp} sizes={sizes} />
      {img}
    </picture>
  );
}
