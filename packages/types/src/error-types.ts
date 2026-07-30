/**
 * Structured error types for Skip API responses.
 *
 * Provides machine-actionable error classification so clients can programmatically
 * handle specific failure scenarios (e.g., re-provisioning a callback key) instead
 * of parsing human-readable error strings.
 *
 * Design follows a two-level taxonomy inspired by Stripe's error model:
 * - `SkipErrorType` — broad category for coarse branching (stable, rarely extended)
 * - `SkipErrorCode` — specific code for precise programmatic responses (extensible)
 *
 * Both use the `const + typeof` pattern matching SkipRequestPhase/SkipResponsePhase.
 */

/**
 * Broad error classification. Maps 1:1 to the server's internal ErrorCategory.
 * Clients can switch on this for coarse handling; unknown values should be
 * treated as 'unknown'.
 */
export const SkipErrorType = {
    /** Database connectivity or query execution failure */
    database: 'database',
    /** AI model invocation failure (rate limit, context overflow, etc.) */
    ai_model: 'ai_model',
    /** Request validation failure (missing fields, invalid format) */
    validation: 'validation',
    /** Component generation or execution failure */
    component: 'component',
    /** Authentication or authorization failure */
    authentication: 'authentication',
    /** Calling server (MJAPI) unreachable or offline */
    server_unreachable: 'server_unreachable',
    /** Query generation or execution failure */
    query: 'query',
    /** Unclassified error */
    unknown: 'unknown',
} as const;
export type SkipErrorType = typeof SkipErrorType[keyof typeof SkipErrorType];

/**
 * Specific, machine-actionable error codes. Clients switch on these for precise
 * programmatic responses (e.g., re-provisioning a callback key on `invalid_callback_key`).
 *
 * Codes are globally unique. New codes can be added without a breaking change —
 * clients should fall back to the `type` for handling unknown codes.
 */
export const SkipErrorCode = {
    // ── authentication ──────────────────────────────────────────────────
    /** The scoped callback API key Skip uses to call back to MJAPI is invalid or expired */
    invalid_callback_key: 'invalid_callback_key',
    /** The Skip API key (x-api-key header) is invalid */
    invalid_api_key: 'invalid_api_key',
    /** The access token (JWT) has expired */
    token_expired: 'token_expired',
    /** User lacks required permissions for the requested operation */
    insufficient_permissions: 'insufficient_permissions',

    // ── server_unreachable ──────────────────────────────────────────────
    /** MJAPI server URL or API key is not configured */
    missing_configuration: 'missing_configuration',
    /** MJAPI endpoint could not be reached (DNS, network, firewall) */
    endpoint_unreachable: 'endpoint_unreachable',
    /** MJAPI endpoint is offline (404, 502, 503) */
    endpoint_offline: 'endpoint_offline',

    // ── validation ──────────────────────────────────────────────────────
    /** A required request field is missing */
    missing_required_field: 'missing_required_field',
    /** A request field has an invalid format or value */
    invalid_request_format: 'invalid_request_format',

    // ── ai_model ────────────────────────────────────────────────────────
    /** AI provider rate limit exceeded */
    rate_limit_exceeded: 'rate_limit_exceeded',
    /** AI model context window exceeded */
    context_overflow: 'context_overflow',
    /** AI provider returned an error */
    model_error: 'model_error',

    // ── database ────────────────────────────────────────────────────────
    /** Database connection failed or timed out */
    connection_failed: 'connection_failed',
    /** Query execution timed out */
    query_timeout: 'query_timeout',

    // ── component ───────────────────────────────────────────────────────
    /** Component code generation failed */
    generation_failed: 'generation_failed',
    /** Component code execution failed in sandbox */
    execution_failed: 'execution_failed',

    // ── query ───────────────────────────────────────────────────────────
    /** Generated SQL was invalid or could not be executed */
    invalid_sql: 'invalid_sql',
    /** Query returned no results */
    empty_result: 'empty_result',

    // ── unknown ─────────────────────────────────────────────────────────
    /** Catch-all for unclassified errors */
    internal_error: 'internal_error',
} as const;
export type SkipErrorCode = typeof SkipErrorCode[keyof typeof SkipErrorCode];

/**
 * Machine-readable hint for what kind of retry the client should attempt.
 */
export const SkipRetryAction = {
    /** Retry the same request without changes */
    retry: 'retry',
    /** Re-provision credentials and retry the request */
    reprovision_and_retry: 'reprovision_and_retry',
    /** Modify the request (simplify, rephrase) and retry */
    modify_and_retry: 'modify_and_retry',
    /** Do not retry — requires user or admin intervention */
    do_not_retry: 'do_not_retry',
} as const;
export type SkipRetryAction = typeof SkipRetryAction[keyof typeof SkipRetryAction];

/**
 * Structured error detail attached to SkipAPIResponse when `success` is false.
 *
 * Provides machine-actionable context so clients can handle specific error
 * scenarios programmatically rather than parsing the `error` string.
 *
 * The `message` field is always identical to `SkipAPIResponse.error` for
 * backward compatibility — old clients that only read `error` continue to work.
 */
export interface SkipErrorDetail {
    /**
     * Broad error category. Stable — new values are rare and additive.
     * Clients should handle unknown types gracefully (treat as 'unknown').
     */
    type: SkipErrorType;

    /**
     * Specific error code for machine-actionable responses. More granular
     * than `type`. New codes are added as needed without breaking changes.
     * Clients should fall back to `type` for unknown codes.
     */
    code: SkipErrorCode;

    /**
     * Human-readable error description.
     */
    message: string;

    /**
     * User-facing suggested action text. Can be displayed directly in UI.
     * Example: "Please verify your MJAPI server is running and accessible."
     */
    suggestedAction?: string;

    /**
     * Whether this error is likely transient and the request can be retried.
     */
    retryable: boolean;

    /**
     * Machine-readable hint for what kind of retry to attempt.
     * Only meaningful when `retryable` is true.
     */
    retryAction?: SkipRetryAction;

    /**
     * Optional technical details. Only populated when the error category
     * is configured to include details (e.g., validation errors).
     * Never contains sensitive information (credentials, internal IPs).
     */
    details?: string;
}
