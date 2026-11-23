import { handleWebhookRoute } from '@/lib/webhook-route';

const handle = (request: Request): Promise<Response> => handleWebhookRoute('wayforpay', request);

// Every method reaches the same limiter; only POST does any work.
export const POST = handle;
export const GET = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
