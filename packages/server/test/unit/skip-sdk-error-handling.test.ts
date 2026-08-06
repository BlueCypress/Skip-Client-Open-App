/**
 * @fileoverview Unit tests for SkipSDK structured error handling and callback key retry logic.
 *
 * Tests cover:
 * 1. errorDetail is surfaced on SkipCallResult when the server returns it
 * 2. invalid_callback_key triggers automatic re-provisioning and retry
 * 3. Retry circuit breaker prevents infinite loops (_isCallbackKeyRetry)
 * 4. Non-retryable errors are returned without retry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    SkipErrorCode,
    SkipRetryAction,
    SkipErrorDetail,
    SkipResponsePhase,
} from '@askskip/types';

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mock the callback key provisioner
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

// Mock @askskip/core
vi.mock('@askskip/core', () => ({
    getSkipConfig: () => ({
        skipURL: 'https://test.askskip.ai',
        apiKey: 'test-api-key',
        baseUrl: 'http://localhost',
        graphqlPort: 4000,
        graphqlRootPath: '/',
        entitiesToSend: { excludeSchemas: [], includeEntitiesFromExcludedSchemas: [] },
    }),
    getDbType: () => 'sqlserver',
    resolveSkipApiKey: vi.fn().mockResolvedValue('test-api-key'),
}));

// Mock MJ dependencies that SkipSDK uses during request building
vi.mock('@memberjunction/core', () => ({
    LogStatus: vi.fn(),
    LogError: vi.fn(),
    Metadata: vi.fn().mockImplementation(() => ({
        Entities: [],
        Provider: { Entities: [] },
    })),
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

vi.mock('@memberjunction/ai', () => ({
    GetAIAPIKey: vi.fn().mockReturnValue(''),
}));

vi.mock('@memberjunction/aiengine', () => ({
    AIEngine: { Instance: { Config: vi.fn(), GetAgentByName: vi.fn().mockReturnValue(null) } },
}));

vi.mock('@memberjunction/global', () => ({
    CopyScalarsAndArrays: (x: unknown) => x,
    UUIDsEqual: (a: string, b: string) => a === b,
}));

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
vi.mock('rxjs/operators', () => ({
    take: () => (x: unknown) => x,
}));

// Now import the SDK after all mocks are set up
import { SkipSDK } from '../../src/skip-sdk.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildErrorDetail(overrides: Partial<SkipErrorDetail> = {}): SkipErrorDetail {
    return {
        type: 'authentication',
        code: SkipErrorCode.invalid_callback_key,
        message: 'Callback key is invalid',
        retryable: true,
        retryAction: SkipRetryAction.reprovision_and_retry,
        ...overrides,
    };
}

/**
 * Creates a SkipSDK instance and stubs sendSSERequest to return controlled responses.
 * Returns the SDK and a setter to control what the next SSE call returns.
 */
function createSdkWithMockedSSE() {
    const sdk = new SkipSDK({ apiUrl: 'https://test.askskip.ai', apiKey: 'test-key' });

    let responses: Array<{ type: string; value: Record<string, unknown> }> = [];

    // Stub the private sendSSERequest method
    (sdk as Record<string, unknown>)['sendSSERequest'] = vi.fn().mockImplementation(() =>
        Promise.resolve(responses)
    );

    const setResponses = (r: typeof responses) => { responses = r; };

    return { sdk, setResponses, sendSSERequest: (sdk as Record<string, unknown>)['sendSSERequest'] as ReturnType<typeof vi.fn> };
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SkipSDK error handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('errorDetail on SkipCallResult', () => {
        it('surfaces errorDetail from the response when success is false', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();
            const detail = buildErrorDetail({ code: SkipErrorCode.model_error, type: 'ai_model', retryable: false });

            setResponses([{
                type: 'complete',
                value: {
                    success: false,
                    errorDetail: detail,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(false);
            expect(result.errorDetail).toBeDefined();
            expect(result.errorDetail!.code).toBe(SkipErrorCode.model_error);
            expect(result.errorDetail!.type).toBe('ai_model');
            expect(result.errorDetail!.retryable).toBe(false);
        });

        it('returns undefined errorDetail on success', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();

            setResponses([{
                type: 'complete',
                value: {
                    success: true,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(true);
            expect(result.errorDetail).toBeUndefined();
        });

        it('extracts error message from errorDetail.message', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();
            const detail = buildErrorDetail({ message: 'Specific error from server' });

            setResponses([{
                type: 'complete',
                value: {
                    success: false,
                    errorDetail: detail,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            const result = await sdk.chat(makeCallOptions());

            expect(result.error).toBe('Specific error from server');
        });

        it('falls back to default message when errorDetail is absent', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();

            setResponses([{
                type: 'complete',
                value: {
                    success: false,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(false);
            expect(result.error).toBe('Skip API returned an error response');
            expect(result.errorDetail).toBeUndefined();
        });
    });

    describe('callback key re-provisioning retry', () => {
        it('retries once when server returns invalid_callback_key with reprovision_and_retry', async () => {
            const { sdk, sendSSERequest } = createSdkWithMockedSSE();
            const errorDetail = buildErrorDetail();

            // First call: error. Second call: success.
            let callCount = 0;
            sendSSERequest.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve([{
                        type: 'complete',
                        value: {
                            success: false,
                            errorDetail,
                            responsePhase: SkipResponsePhase.analysis_complete,
                            messages: [],
                        },
                    }]);
                }
                return Promise.resolve([{
                    type: 'complete',
                    value: {
                        success: true,
                        responsePhase: SkipResponsePhase.analysis_complete,
                        messages: [{ role: 'system', content: 'Success after retry' }],
                    },
                }]);
            });

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(true);
            expect(mockResetCallbackKeyProvisioning).toHaveBeenCalledOnce();
            expect(sendSSERequest).toHaveBeenCalledTimes(2);
        });

        it('does not retry more than once (circuit breaker)', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();
            const errorDetail = buildErrorDetail();

            // Always return the same error — should only call twice (original + one retry)
            setResponses([{
                type: 'complete',
                value: {
                    success: false,
                    errorDetail,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            const result = await sdk.chat(makeCallOptions());

            // Second call has _isCallbackKeyRetry=true, so it won't retry again
            expect(result.success).toBe(false);
            expect(result.errorDetail!.code).toBe(SkipErrorCode.invalid_callback_key);
            expect(mockResetCallbackKeyProvisioning).toHaveBeenCalledOnce();
        });

        it('does not retry for non-callback-key errors', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();
            const detail = buildErrorDetail({
                code: SkipErrorCode.model_error,
                type: 'ai_model',
                retryAction: SkipRetryAction.modify_and_retry,
            });

            setResponses([{
                type: 'complete',
                value: {
                    success: false,
                    errorDetail: detail,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(false);
            expect(mockResetCallbackKeyProvisioning).not.toHaveBeenCalled();
        });

        it('does not retry when retryAction is not reprovision_and_retry', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();
            const detail = buildErrorDetail({
                code: SkipErrorCode.invalid_callback_key,
                retryAction: SkipRetryAction.do_not_retry, // different action
            });

            setResponses([{
                type: 'complete',
                value: {
                    success: false,
                    errorDetail: detail,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(false);
            expect(mockResetCallbackKeyProvisioning).not.toHaveBeenCalled();
        });
    });

    describe('callback key delivery confirmation', () => {
        it('confirms delivery when Skip returns a successful response', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();

            setResponses([{
                type: 'complete',
                value: {
                    success: true,
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            await sdk.chat(makeCallOptions());

            expect(mockConfirmCallbackKeyDelivered).toHaveBeenCalled();
            expect(mockDiscardUnconfirmedCallbackKey).not.toHaveBeenCalled();
        });

        it('confirms delivery even when Skip reports a workflow error', async () => {
            // Skip resolves the callback credential before running any workflow, so a
            // Skip-side error still proves the key was received and stored.
            const { sdk, setResponses } = createSdkWithMockedSSE();

            setResponses([{
                type: 'complete',
                value: {
                    success: false,
                    errorDetail: buildErrorDetail({
                        code: SkipErrorCode.model_error,
                        type: 'ai_model',
                        retryAction: SkipRetryAction.do_not_retry,
                    }),
                    responsePhase: SkipResponsePhase.analysis_complete,
                    messages: [],
                },
            }]);

            await sdk.chat(makeCallOptions());

            expect(mockConfirmCallbackKeyDelivered).toHaveBeenCalled();
            expect(mockDiscardUnconfirmedCallbackKey).not.toHaveBeenCalled();
        });

        it('discards an unconfirmed key when the request fails before Skip reads it', async () => {
            // The 401-at-the-edge case: the key was minted and sent, but Skip never
            // parsed the body, so keeping the row would wedge the next restart.
            const { sdk } = createSdkWithMockedSSE();
            (sdk as Record<string, unknown>)['sendSSERequest'] = vi.fn().mockRejectedValue(
                new Error('HTTP 401: Please provide an API key via X-API-Key header')
            );

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(false);
            expect(mockDiscardUnconfirmedCallbackKey).toHaveBeenCalled();
            expect(mockConfirmCallbackKeyDelivered).not.toHaveBeenCalled();
        });

        it('discards an unconfirmed key when no response is received', async () => {
            const { sdk, setResponses } = createSdkWithMockedSSE();
            setResponses([]);

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(false);
            expect(mockDiscardUnconfirmedCallbackKey).toHaveBeenCalled();
            expect(mockConfirmCallbackKeyDelivered).not.toHaveBeenCalled();
        });
    });

    describe('missing Skip API key', () => {
        it('fails before provisioning a callback key when no API key is configured', async () => {
            // Guards the original defect: without this, buildSkipRequest() mints a scoped
            // callback key for a request the edge rejects, orphaning it permanently.
            const sdk = new SkipSDK({ apiUrl: 'https://test.askskip.ai', apiKey: 'placeholder' });
            // The constructor falls back to getSkipConfig().apiKey (mocked non-empty), so
            // clear the resolved value directly to model an unconfigured environment.
            (sdk as unknown as { config: { apiKey?: string } }).config.apiKey = '';
            const sendSSERequest = vi.fn();
            (sdk as Record<string, unknown>)['sendSSERequest'] = sendSSERequest;
            // ensureConfig() falls back to the credential store; make it come up empty too.
            (sdk as Record<string, unknown>)['ensureConfig'] = vi.fn().mockResolvedValue(undefined);

            const result = await sdk.chat(makeCallOptions());

            expect(result.success).toBe(false);
            expect(result.error).toContain('ASK_SKIP_API_KEY');
            expect(sendSSERequest).not.toHaveBeenCalled();
            expect(mockGetSkipCallbackKey).not.toHaveBeenCalled();
        });
    });
});
