import { createStorage, type Storage } from '@store/media/storage';

import { runtimeEnv } from './runtime-env';

export interface MediaConfig {
  storage: Storage;
  /** Public base URL (no trailing slash); an object key is appended to it. */
  publicBase: string;
}

/**
 * The media storage from the validated environment, or null when it is not configured (no R2
 * credentials, no public address): uploads then answer "not configured" instead of failing late.
 * Credentials stay on the server; nothing here is ever returned to a client.
 */
export async function mediaConfig(): Promise<MediaConfig | null> {
  const env = await runtimeEnv();
  if (
    env.R2_ACCESS_KEY_ID === undefined ||
    env.R2_SECRET_ACCESS_KEY === undefined ||
    env.R2_BUCKET_MEDIA === undefined ||
    env.MEDIA_PUBLIC_BASE_URL === undefined ||
    (env.R2_ENDPOINT === undefined && env.R2_ACCOUNT_ID === undefined)
  ) {
    return null;
  }
  const endpoint = env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID ?? ''}.r2.cloudflarestorage.com`;
  return {
    storage: createStorage({
      endpoint,
      bucket: env.R2_BUCKET_MEDIA,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
    publicBase: env.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, ''),
  };
}
