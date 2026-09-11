const HOST_CODES = new Set([
  'unauthorized', 'invalid_identity', 'already_bound', 'invalid_host_event', 'host_session_unavailable',
  'kernel_timeout', 'kernel_disconnected', 'kernel_draining', 'invalid_ipc_response', 'ipc_message_limit',
  'host_input_limit', 'hook_timeout', 'hook_unavailable', 'processing_failed',
  'paused', 'version_conflict', 'source_deleted', 'timeout', 'invalid_input', 'model_preparing',
  'download_failed', 'disk_full', 'model_stopped', 'model_busy', 'model_timeout', 'model_unavailable',
  'checksum_mismatch', 'unsupported_platform', 'model_output_invalid', 'model_failed',
  'http_body_limit', 'invalid_http_token', 'invalid_http_port', 'invalid_http_option',
  'server_already_running', 'http_request_failed',
]);

/** Return stable error categories without emitting exception messages that may contain source text. */
export function safeErrorCode(error: unknown, fallback = 'processing_failed'): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{3,60}$/.test(error.code)) return error.code.toLowerCase();
  if (error instanceof Error && HOST_CODES.has(error.message)) return error.message;
  return fallback;
}
