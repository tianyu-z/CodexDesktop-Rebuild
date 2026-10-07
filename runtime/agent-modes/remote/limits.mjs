export const MiB = 1024 * 1024;
export const DESKTOP_REQUEST_BYTES = 16 * MiB;
export const OWNER_RESPONSE_BYTES = 128 * MiB;
export const DESKTOP_RESPONSE_BYTES = 64 * MiB;
export const OUTPUT_QUEUE_BYTES = 32 * MiB;
export const HARD_OUTPUT_QUEUE_BYTES = 64 * MiB;

export const sizeError = (bytes, limit) => ({ code: -32000,
  message: `decoded message length too large: RPC response is ${bytes} bytes; limit is ${limit} bytes. The request may already have executed; read state before retrying a mutation.` });
export const pressureError = () => ({ code: -32000,
  message: 'Remote gateway output is backlogged. Retry this read after the connection drains. A mutation may already have executed; read state before retrying.' });
