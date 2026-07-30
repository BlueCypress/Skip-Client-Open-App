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

vi.mock('../../src/skip-callback-key-provisioner.js', () => ({
    getSkipCallbackKey: (...args: unknown[]) => mockGetSkipCallbackKey(...args),
    resetCallbackKeyProvisioning: (...args: unknown[]) => mockResetCallbackKeyProvisioning(...args),
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
});
