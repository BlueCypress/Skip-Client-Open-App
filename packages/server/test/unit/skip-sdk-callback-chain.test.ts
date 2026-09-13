/**
 * @fileoverview Unit tests for the three links in the Skip callback chain.
 *
 * Each pins a separate way the chain used to report something other than what it gated:
 *
 * 1. The callback URL — an unset `MJAPI_PUBLIC_URL` composed `http://localhost:4000/` and
 *    sent it to Skip as the address to dial back. `chat()` now refuses the request and says
 *    which variable is missing, instead of producing Skip's "unable to reach your server".
 * 2. The reprovision trigger — required `invalid_callback_key` AND `reprovision_and_retry`.
 *    The observed wedge (Skip's stored callback key became undecryptable) arrived as
 *    `[unknown/internal_error]` and satisfied neither, so recovery became a hand-written
 *    UPDATE against the tenant database.
 * 3. The delivery receipt — `confirmCallbackKeyDelivered()` ran before the success check, so
 *    a response whose entire content was "your callback credential does not work" was
 *    recorded as proof the credential had been delivered, permanently blocking the discard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    SkipErrorCode,
    SkipRetryAction,
    SkipErrorDetail,
    SkipResponsePhase,
} from '@askskip/types';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockResetCallbackKeyProvisioning = vi.fn().mockResolvedValue(undefined);
const mockGetSkipCallbackKey = vi.fn().mockResolvedValue(null);
const mockConfirmCallbackKeyDelivered = vi.fn();
const mockDiscardUnconfirmedCallbackKey = vi.fn().mockResolvedValue(false);

vi.mock('../../src/skip-callback-key-provisioner.js', () => ({
    getSkipCallbackKey: (...args: unknown[]) => mockGetSkipCallbackKey(...args),
    resetCallbackKeyProvisioning: (...args: unknown[]) => mockResetCallbackKeyProvisioning(...args),
    confirmCallbackKeyDelivered: (...args: unknown[]) => mockConfirmCallbackKeyDelivered(...args),
    discardUnconfirmedCallbackKey: (...args: unknown[]) => mockDiscardUnconfirmedCallbackKey(...args),
}));

/**
 * The callback configuration under test, mutated per test. `getSkipConfig()` is read on
 * every request, so flipping this between calls models an operator's environment rather
 * than requiring a module reset.
 */
const callbackConfig: { baseUrl?: string; publicUrl?: string } = {
    baseUrl: 'http://localhost',
    publicUrl: 'https://mjapi.test.example.com/',
};

vi.mock('@askskip/core', () => ({
    getSkipConfig: () => ({
        skipURL: 'https://test.askskip.ai',
        apiKey: 'test-api-key',
        baseUrl: callbackConfig.baseUrl,
        publicUrl: callbackConfig.publicUrl,
        graphqlPort: 4000,
        graphqlRootPath: '/',
        entitiesToSend: { excludeSchemas: [], includeEntitiesFromExcludedSchemas: [] },
    }),
    getDbType: () => 'sqlserver',
    resolveSkipApiKey: vi.fn().mockResolvedValue('test-api-key'),
}));

vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    Metadata: vi.fn().mockImplementation(() => ({ Entities: [], Provider: { Entities: [] } })),
    RunView: vi.fn().mockImplementation(() => ({
        RunView: vi.fn().mockResolvedValue({ Success: true, Results: [] }),
    })),
    RunQuery: vi.fn().mockImplementation(() => ({
        RunQuery: vi.fn().mockResolvedValue({ Success: true, Results: [] }),
    })),
    EntityInfo: vi.fn(),
    EntityFieldInfo: vi.fn(),
    EntityFieldValueInfo: vi.fn(),
}));

vi.mock('@memberjunction/core-entities', () => ({
    QueryEngine: { Instance: { Queries: [], Categories: [], QueryEntities: [], GetQueryFields: () => [], GetQueryParameters: () => [] } },
}));

vi.mock('@memberjunction/ai', () => ({ GetAIAPIKey: vi.fn().mockReturnValue('') }));
vi.mock('@memberjunction/aiengine', () => ({
    AIEngine: { Instance: { Config: vi.fn(), GetAgentByName: vi.fn().mockReturnValue(null) } },
}));
vi.mock('@memberjunction/global', async (importOriginal) => ({
    CopyScalarsAndArrays: (x: unknown) => x,
    UUIDsEqual: (a: string, b: string) => a === b,
    IsValidUUID: (await importOriginal<typeof import('@memberjunction/global')>()).IsValidUUID,
}));

/**
 * MJServer is absent in unit tests, which is also the real fallback path: when the import
 * fails the SDK keeps the env-derived values. Rejecting here exercises that branch, so the
 * refusal below is decided by `getSkipConfig()` alone and nothing silently supplies a URL.
 */
vi.mock('@memberjunction/server', () => {
    throw new Error('MJServer is not loadable in unit tests');
});

vi.mock('mssql', () => ({}));
vi.mock('rxjs', () => {
    class MockBehaviorSubject {
        value: unknown;
        constructor(initial: unknown) { this.value = initial; }
        next(val: unknown) { this.value = val; }
        pipe() { return { toPromise: () => Promise.resolve([]) }; }
    }
    return { BehaviorSubject: MockBehaviorSubject };
});
vi.mock('rxjs/operators', () => ({ take: () => (x: unknown) => x }));

import { SkipSDK, shouldReprovisionCallbackKey } from '../../src/skip-sdk.js';
import { MJAPI_PUBLIC_URL_ENV_VAR } from '../../src/skip-callback-url.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildErrorDetail(overrides: Partial<SkipErrorDetail> = {}): SkipErrorDetail {
    return {
        type: 'unknown',
        code: SkipErrorCode.internal_error,
        message: 'Something went wrong',
        retryable: false,
        ...overrides,
    };
}

function createSdkWithMockedSSE() {
    const sdk = new SkipSDK({ apiUrl: 'https://test.askskip.ai', apiKey: 'test-key' });
    let responses: Array<Record<string, unknown>> = [];
    const sendSSERequest = vi.fn().mockImplementation(() => Promise.resolve(responses));
    (sdk as Record<string, unknown>)['sendSSERequest'] = sendSSERequest;
    return {
        sdk,
        sendSSERequest,
        setResponses: (r: typeof responses) => { responses = r; },
    };
}

function makeCallOptions(overrides = {}) {
    return {
        messages: [{ role: 'user' as const, content: 'test', conversationDetailID: 'cd-1' }],
        conversationId: 'conv-1',
        contextUser: { ID: 'user-1', Email: 'test@test.com' } as never,
        dataSource: {} as never,
        ...overrides,
    };
}

/** One wrapped final response reporting a Skip-side failure. */
function failureResponse(detail?: SkipErrorDetail) {
    return [{
        type: 'complete',
        value: {
            success: false,
            errorDetail: detail,
            responsePhase: SkipResponsePhase.analysis_complete,
            messages: [],
        },
    }];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('the callback URL refuses to be a loopback address', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        callbackConfig.baseUrl = 'http://localhost';
        callbackConfig.publicUrl = 'https://mjapi.test.example.com/';
    });

    it('refuses the request when MJAPI_PUBLIC_URL is unset and the base URL is loopback', async () => {
        callbackConfig.publicUrl = undefined;
        const { sdk, sendSSERequest } = createSdkWithMockedSSE();

        const result = await sdk.chat(makeCallOptions());

        expect(result.success).toBe(false);
        expect(result.error).toContain(MJAPI_PUBLIC_URL_ENV_VAR);
        // Nothing left this process. Sending the request would have produced Skip's
        // "unable to reach your server", which is the misdiagnosis being fixed.
        expect(sendSSERequest).not.toHaveBeenCalled();
    });

    it('mints no callback key for a request it is about to refuse', async () => {
        // Ordering matters as much as the refusal: the provisioner mints a scoped key as a
        // side effect of building the request, and a key Skip never receives outlives its
        // own raw value and wedges the next restart.
        callbackConfig.publicUrl = undefined;
        const { sdk } = createSdkWithMockedSSE();

        await sdk.chat(makeCallOptions());

        expect(mockGetSkipCallbackKey).not.toHaveBeenCalled();
    });

    it('blames configuration rather than credentials', async () => {
        callbackConfig.publicUrl = undefined;
        const { sdk } = createSdkWithMockedSSE();

        const result = await sdk.chat(makeCallOptions());

        expect(result.error).toContain('not a credential problem');
    });

    it('refuses when neither MJAPI_PUBLIC_URL nor GRAPHQL_BASE_URL is set', async () => {
        callbackConfig.publicUrl = undefined;
        callbackConfig.baseUrl = undefined;
        const { sdk, sendSSERequest } = createSdkWithMockedSSE();

        const result = await sdk.chat(makeCallOptions());

        expect(result.success).toBe(false);
        expect(sendSSERequest).not.toHaveBeenCalled();
    });

    it('sends the request when an explicit public URL is configured', async () => {
        const { sdk, sendSSERequest, setResponses } = createSdkWithMockedSSE();
        setResponses([{
            type: 'complete',
            value: { success: true, responsePhase: SkipResponsePhase.analysis_complete, messages: [] },
        }]);

        const result = await sdk.chat(makeCallOptions());

        expect(result.success).toBe(true);
        expect(sendSSERequest).toHaveBeenCalledOnce();
    });

    it('still sends a request that advertises no callback credential at all', async () => {
        // `includeCallbackAuth: false` requests carry no callback address, so an
        // unresolvable one cannot affect them and must not block them.
        callbackConfig.publicUrl = undefined;
        const { sdk, sendSSERequest, setResponses } = createSdkWithMockedSSE();
        setResponses([{
            type: 'complete',
            value: { success: true, responsePhase: SkipResponsePhase.analysis_complete, messages: [] },
        }]);

        const result = await sdk.chat(makeCallOptions({ includeCallbackAuth: false }));

        expect(result.success).toBe(true);
        expect(sendSSERequest).toHaveBeenCalledOnce();
    });

    it('tells the user which address Skip was given when Skip says it could not reach us', async () => {
        // Skip's own wording ("unable to reach your server ... verify the tunnel is active")
        // never names the address it tried, and only this side knows it.
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(buildErrorDetail({
            type: 'server_unreachable',
            code: SkipErrorCode.endpoint_unreachable,
            message: 'Unable to reach your server.',
        })));

        const result = await sdk.chat(makeCallOptions());

        expect(result.success).toBe(false);
        expect(result.error).toContain('https://mjapi.test.example.com/');
    });
});

describe('reprovisioning triggers on anything a fresh callback key could fix', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        callbackConfig.baseUrl = 'http://localhost';
        callbackConfig.publicUrl = 'https://mjapi.test.example.com/';
    });

    it('reprovisions on the internal_error that wedged a live tenant', async () => {
        // The exact shape recovered by hand in production: Skip could not decrypt its stored
        // callback key and reported [unknown/internal_error], which the old two-condition
        // gate ignored. `scripts/plus-skip-reprovision-callback-key.sh` existed only because
        // of this, and flipped MJAPIKey.Status in the tenant database to work around it.
        const { sdk, sendSSERequest } = createSdkWithMockedSSE();
        let calls = 0;
        sendSSERequest.mockImplementation(() => {
            calls++;
            return Promise.resolve(calls === 1
                ? failureResponse(buildErrorDetail({
                    type: 'unknown',
                    code: SkipErrorCode.internal_error,
                    message: 'Failed to decrypt the stored callback key: Credential not found: APIKey',
                }))
                : [{
                    type: 'complete',
                    value: { success: true, responsePhase: SkipResponsePhase.analysis_complete, messages: [] },
                }]);
        });

        const result = await sdk.chat(makeCallOptions());

        expect(mockResetCallbackKeyProvisioning).toHaveBeenCalledOnce();
        expect(sendSSERequest).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true);
    });

    it('reprovisions when Skip sends no structured error detail at all', async () => {
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(undefined));

        await sdk.chat(makeCallOptions());

        expect(mockResetCallbackKeyProvisioning).toHaveBeenCalledOnce();
    });

    it('still retries at most once, however broad the trigger', async () => {
        // The circuit breaker carries more weight now that almost any failure can trip the
        // trigger. Two SSE calls, one reset, whatever the error.
        const { sdk, sendSSERequest, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(buildErrorDetail()));

        const result = await sdk.chat(makeCallOptions());

        expect(result.success).toBe(false);
        expect(mockResetCallbackKeyProvisioning).toHaveBeenCalledOnce();
        expect(sendSSERequest).toHaveBeenCalledTimes(2);
    });

    it('does not reprovision for a failure a new key cannot fix', async () => {
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(buildErrorDetail({
            type: 'ai_model',
            code: SkipErrorCode.rate_limit_exceeded,
            retryable: true,
            retryAction: SkipRetryAction.retry,
        })));

        await sdk.chat(makeCallOptions());

        expect(mockResetCallbackKeyProvisioning).not.toHaveBeenCalled();
    });

    it('does not reprovision when the request advertised no callback credential', async () => {
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(buildErrorDetail()));

        await sdk.chat(makeCallOptions({ includeCallbackAuth: false }));

        expect(mockResetCallbackKeyProvisioning).not.toHaveBeenCalled();
    });

    describe('the predicate directly', () => {
        it('reprovisions for the callback-credential and unrecognised classes', () => {
            const cases: Array<Partial<SkipErrorDetail>> = [
                { code: SkipErrorCode.invalid_callback_key, type: 'authentication' },
                { code: SkipErrorCode.missing_configuration, type: 'server_unreachable' },
                { code: SkipErrorCode.internal_error, type: 'unknown' },
                { code: SkipErrorCode.token_expired, type: 'authentication' },
                { code: SkipErrorCode.insufficient_permissions, type: 'authentication' },
                { code: SkipErrorCode.model_error, type: 'ai_model', retryAction: SkipRetryAction.reprovision_and_retry },
                { code: SkipErrorCode.invalid_sql, type: 'unknown' },
            ];
            for (const overrides of cases) {
                const detail = buildErrorDetail(overrides);
                expect(shouldReprovisionCallbackKey(detail, true), detail.code).toBe(true);
            }
            expect(shouldReprovisionCallbackKey(undefined, true)).toBe(true);
        });

        it('leaves a working key alone for failures identified as something else', () => {
            const cases: Array<Partial<SkipErrorDetail>> = [
                // Our outbound key to Skip. Different credential, different fix, and
                // reprovisioning would destroy a working callback key for nothing.
                { code: SkipErrorCode.invalid_api_key, type: 'authentication' },
                // The address or this instance's availability is wrong; a key changes neither.
                { code: SkipErrorCode.endpoint_unreachable, type: 'server_unreachable' },
                { code: SkipErrorCode.endpoint_offline, type: 'server_unreachable' },
                { code: SkipErrorCode.rate_limit_exceeded, type: 'ai_model' },
                { code: SkipErrorCode.context_overflow, type: 'ai_model' },
                { code: SkipErrorCode.missing_required_field, type: 'validation' },
                { code: SkipErrorCode.connection_failed, type: 'database' },
                { code: SkipErrorCode.generation_failed, type: 'component' },
                { code: SkipErrorCode.empty_result, type: 'query' },
            ];
            for (const overrides of cases) {
                const detail = buildErrorDetail(overrides);
                expect(shouldReprovisionCallbackKey(detail, true), detail.code).toBe(false);
            }
        });

        it('never fires for a request that carried no callback credential', () => {
            expect(shouldReprovisionCallbackKey(undefined, false)).toBe(false);
            expect(shouldReprovisionCallbackKey(buildErrorDetail({
                code: SkipErrorCode.invalid_callback_key,
            }), false)).toBe(false);
        });
    });
});

describe('delivery is not confirmed by the failure that falsifies it', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        callbackConfig.baseUrl = 'http://localhost';
        callbackConfig.publicUrl = 'https://mjapi.test.example.com/';
    });

    it('does not confirm delivery when Skip reports the callback credential failing', async () => {
        // This is the cementing bug. `confirmCallbackKeyDelivered()` ran before the success
        // check, so `deliveryConfirmed` was written for a response that said the credential
        // did not work — and once written, `discardUnconfirmedCallbackKey()` is a no-op for
        // the rest of the process. The provisioner's docstring named the outcome:
        // "unrecoverable without deleting the row by hand".
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(buildErrorDetail({
            type: 'authentication',
            code: SkipErrorCode.invalid_callback_key,
            retryAction: SkipRetryAction.do_not_retry,
        })));

        await sdk.chat(makeCallOptions());

        expect(mockConfirmCallbackKeyDelivered).not.toHaveBeenCalled();
    });

    it('does not confirm delivery for the undecryptable-key internal_error either', async () => {
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(buildErrorDetail({
            type: 'unknown',
            code: SkipErrorCode.internal_error,
        })));

        await sdk.chat(makeCallOptions());

        expect(mockConfirmCallbackKeyDelivered).not.toHaveBeenCalled();
    });

    it('still confirms delivery for a Skip-side workflow error', async () => {
        // The original rationale survives where it is actually sound: Skip resolves the
        // callback credential before running any workflow, so a workflow failure does prove
        // receipt. It is only circular when credential resolution is itself what broke.
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses(failureResponse(buildErrorDetail({
            type: 'ai_model',
            code: SkipErrorCode.model_error,
            retryAction: SkipRetryAction.do_not_retry,
        })));

        await sdk.chat(makeCallOptions());

        expect(mockConfirmCallbackKeyDelivered).toHaveBeenCalled();
    });

    it('still confirms delivery on success', async () => {
        const { sdk, setResponses } = createSdkWithMockedSSE();
        setResponses([{
            type: 'complete',
            value: { success: true, responsePhase: SkipResponsePhase.analysis_complete, messages: [] },
        }]);

        await sdk.chat(makeCallOptions());

        expect(mockConfirmCallbackKeyDelivered).toHaveBeenCalled();
    });
});
