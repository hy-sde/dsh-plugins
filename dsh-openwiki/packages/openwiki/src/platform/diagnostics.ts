/**
 * Redaction and secret-detection helpers shared by error paths that could
 * surface credential material to the model or a log.
 *
 * Ported from openwiki 0.4's platform/diagnostics.ts and trimmed to the
 * deterministic engine's needs: the fork runs no LLM provider calls, so the
 * provider-auth classifiers (getErrorMessage / isAuthError /
 * isOpenRouterServerError) and the provider constants table are not ported.
 * The security boundary itself (sanitizeDiagnosticText + isSecretLikeKey) is
 * retained verbatim, with the provider env-key list inlined.
 */

/**
 * Known credential-bearing environment keys whose current values, when set,
 * are redacted by {@link sanitizeDiagnosticText}.
 */
const SECRET_ENV_KEYS = [
  'BASETEN_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'COPILOT_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'NEBIUS_API_KEY',
  'NVIDIA_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'LANGSMITH_API_KEY',
] as const

/**
 * Redacts secrets from text before it is shown to the user or written to a log.
 *
 * This is a security boundary: any error message, header value, or provider
 * response body that could contain a credential must pass through here first.
 * It removes (1) the exact values of secrets currently set in the environment
 * and (2) anything matching known key/token shapes (OpenAI/OpenRouter `sk-…`,
 * `Bearer …`, LangSmith `ls…`, and "Incorrect API key provided: …" phrasing).
 */
export function sanitizeDiagnosticText(value: string): string {
  let sanitized = value

  for (const envKey of SECRET_ENV_KEYS) {
    const secret = process.env[envKey]

    if (secret && secret.length > 0) {
      sanitized = sanitized.split(secret).join(`[REDACTED:${envKey}]`)
    }
  }

  return sanitized
    .replace(
      /(Incorrect API key provided:\s*)([^\s.]+)/giu,
      '$1[REDACTED:API_KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [REDACTED]')
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+/gu, '[REDACTED:OPENROUTER_API_KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, '[REDACTED:API_KEY]')
    .replace(/\bls[v_][A-Za-z0-9_-]+/gu, '[REDACTED:LANGSMITH_API_KEY]')
}

/**
 * The union of every substring that marks a key/field name as secret-bearing.
 * Single source of truth for all redaction paths — extend this, not the
 * individual call sites.
 */
export const SECRET_KEY_PATTERN_SOURCE =
  'api[-_]?key|authorization|bearer|token|secret|password|user_id|cookie'

/**
 * True when an object key name looks like it holds a credential, so its value
 * should be redacted before display, logging, or persistence.
 */
export function isSecretLikeKey(key: string): boolean {
  return new RegExp(SECRET_KEY_PATTERN_SOURCE, 'iu').test(key)
}
