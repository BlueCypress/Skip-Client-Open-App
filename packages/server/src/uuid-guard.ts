/**
 * UUID guards shared by the SDK and the proxy agent. Validation itself is MJ's
 * IsValidUUID from @memberjunction/global; these wrappers add the TypeScript
 * type-guard narrowing and a throwing variant for use before interpolating
 * caller-supplied record IDs into SQL filter strings.
 */
import { IsValidUUID } from '@memberjunction/global';

/** Returns true when the value is a well-formed UUID, narrowing it to string. */
export function isValidUUID(value: string | null | undefined): value is string {
    return IsValidUUID(value);
}

/**
 * Validates that a value is a well-formed UUID and returns it, throwing otherwise.
 * A passing value cannot carry SQL injection payloads.
 */
export function requireValidUUID(value: string | null | undefined, context: string): string {
    if (!isValidUUID(value)) {
        throw new Error(`${context}: expected a UUID, got ${value === undefined ? 'undefined' : JSON.stringify(value)}`);
    }
    return value;
}
