/**
 * Resolution of the callback URL this MJAPI advertises to Skip as `callingServerURL`.
 *
 * This is the one address in the whole configuration surface that is dialled by a
 * *remote* service. Every other URL here is dialled by this process, which is why a
 * loopback default is correct for them and never correct for this one: `http://localhost`
 * handed to Skip's cloud names Skip's own container, not this instance.
 *
 * The failure that motivated this module is the misdiagnosis, not the URL. Skip's cloud
 * answers a loopback callback with "I'm unable to reach your server. Please make sure your
 * MJAPI instance is running and accessible. If you're using a tunnel service like ngrok,
 * verify the tunnel is active." — and every part of that sentence points away from the
 * actual cause. So this module refuses to compose an address that cannot work, and says
 * exactly which variable is missing and that credentials are not the problem.
 *
 * Deliberately dependency-free: no MJ imports, no env reads, no I/O. Callers pass the
 * configuration they already resolved, which is what makes both the SDK's request path
 * and the middleware's boot log able to reach the same verdict from the same inputs.
 */

/** Environment variable that names the address Skip should call back on. */
export const MJAPI_PUBLIC_URL_ENV_VAR = 'MJAPI_PUBLIC_URL';

/** Environment variable holding this instance's base URL, used when the public URL is unset. */
export const GRAPHQL_BASE_URL_ENV_VAR = 'GRAPHQL_BASE_URL';

/** The configuration the callback URL is derived from. */
export interface SkipCallbackURLInputs {
    /** `MJAPI_PUBLIC_URL` — an explicit, complete callback address. Wins outright when set. */
    publicUrl?: string;
    /** `GRAPHQL_BASE_URL` (or MJServer's `configInfo.baseUrl`) — scheme + host, no port. */
    baseUrl?: string;
    /** `GRAPHQL_PORT`. */
    graphqlPort?: number;
    /** `GRAPHQL_ROOT_PATH`. */
    graphqlRootPath?: string;
}

/** Which input produced the callback URL. */
export type SkipCallbackURLSource = 'publicUrl' | 'baseUrl';

/** Why no callback URL could be produced. Drives the remedy text, and is worth asserting on. */
export type SkipCallbackURLFailure =
    /** Neither `MJAPI_PUBLIC_URL` nor `GRAPHQL_BASE_URL` has a value. */
    | 'unconfigured'
    /** `GRAPHQL_BASE_URL` names a loopback host, which a remote caller cannot dial. */
    | 'loopback'
    /** A value is present but is not a URL we can read a host out of. */
    | 'unparseable';

/**
 * A resolved callback URL, or a refusal carrying the operator-facing reason.
 *
 * There is deliberately no third state. Returning a loopback address with a warning is
 * what produced the original incident: the warning scrolled past in boot logs and the
 * address went to Skip anyway.
 */
export type SkipCallbackURLResolution =
    | { ok: true; url: string; source: SkipCallbackURLSource }
    | { ok: false; reason: SkipCallbackURLFailure; error: string; rejectedValue?: string };

/**
 * Reads the host out of a URL-ish string, tolerating a missing scheme.
 * Returns null when no host can be determined — including for a value that parses as a
 * URL but has no host at all (`mailto:`, a bare path).
 */
function hostOf(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const candidate = /^[a-z][a-z0-9+.\-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        const host = new URL(candidate).hostname.toLowerCase();
        if (!host) {
            return null;
        }
        // IPv6 hostnames come back bracketed (`[::1]`); compare the address itself.
        return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    } catch {
        return null;
    }
}

/**
 * True when `host` can only be reached from the machine it names.
 *
 * Matched exactly, never by substring: `localhost.example.com` is an ordinary public
 * name and `127.0.0.1.nip.io` resolves to loopback but is not one syntactically — the
 * first must not be rejected, and the second is the operator's explicit choice.
 * `*.localhost` is included because RFC 6761 reserves that suffix for loopback.
 */
export function isLoopbackHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    if (!h) {
        return false;
    }
    if (h === 'localhost' || h.endsWith('.localhost')) {
        return true;
    }
    if (h === '::1' || h === '::' || h === '0.0.0.0') {
        return true;
    }
    // The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1.
    return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);
}

/** Shared closing sentence: the misdiagnosis this whole module exists to prevent. */
const NOT_A_CREDENTIAL_PROBLEM =
    `This is a deployment configuration problem, not a credential problem — neither the Skip ` +
    `API key nor the scoped callback key has any bearing on it, so rotating or re-entering ` +
    `them will not help.`;

/** Shared remedy sentence. */
const REMEDY =
    `Set ${MJAPI_PUBLIC_URL_ENV_VAR} to the address Skip should call back on ` +
    `(for example https://mjapi.example.com/) and restart MJAPI. When MJAPI and the Skip brain ` +
    `both run on this machine, set ${MJAPI_PUBLIC_URL_ENV_VAR} explicitly to the loopback ` +
    `address — an explicit loopback is honoured, an implied one is not.`;

/**
 * Resolves the callback URL, or refuses with the reason.
 *
 * 1. `publicUrl` set → used verbatim. It is Skip-specific and unambiguous, so a loopback
 *    value here is an opt-in (a brain running on the same machine) rather than a leftover
 *    default, and is honoured.
 * 2. `publicUrl` unset, `baseUrl` names a routable host → `${baseUrl}:${port}${rootPath}`.
 * 3. Anything else → refusal.
 *
 * Note what case 3 covers that a "required variable" check would not: `baseUrl` is rarely
 * unset, because MJServer's own config defaults it to `http://localhost` — correct for the
 * URLs this process dials itself, and the reason the bad callback address looked configured.
 * The host, not the presence of a value, is what decides here.
 */
export function resolveSkipCallbackURL(inputs: SkipCallbackURLInputs): SkipCallbackURLResolution {
    const publicUrl = inputs.publicUrl?.trim();
    if (publicUrl) {
        if (hostOf(publicUrl) === null) {
            return {
                ok: false,
                reason: 'unparseable',
                rejectedValue: publicUrl,
                error:
                    `Skip has no usable callback URL: ${MJAPI_PUBLIC_URL_ENV_VAR} is set to ` +
                    `"${publicUrl}", which is not a URL with a host. ${REMEDY} ${NOT_A_CREDENTIAL_PROBLEM}`,
            };
        }
        return { ok: true, url: publicUrl, source: 'publicUrl' };
    }

    const baseUrl = inputs.baseUrl?.trim();
    if (!baseUrl) {
        return {
            ok: false,
            reason: 'unconfigured',
            error:
                `Skip has no callback URL: neither ${MJAPI_PUBLIC_URL_ENV_VAR} nor ` +
                `${GRAPHQL_BASE_URL_ENV_VAR} is set, so there is no address to advertise as ` +
                `callingServerURL. ${REMEDY} ${NOT_A_CREDENTIAL_PROBLEM}`,
        };
    }

    const host = hostOf(baseUrl);
    if (host === null) {
        return {
            ok: false,
            reason: 'unparseable',
            rejectedValue: baseUrl,
            error:
                `Skip has no usable callback URL: ${GRAPHQL_BASE_URL_ENV_VAR} is set to ` +
                `"${baseUrl}", which is not a URL with a host. ${REMEDY} ${NOT_A_CREDENTIAL_PROBLEM}`,
        };
    }

    if (isLoopbackHost(host)) {
        return {
            ok: false,
            reason: 'loopback',
            rejectedValue: baseUrl,
            error:
                `Skip has no reachable callback URL: ${MJAPI_PUBLIC_URL_ENV_VAR} is not set and ` +
                `${GRAPHQL_BASE_URL_ENV_VAR} is "${baseUrl}", whose host (${host}) is a loopback ` +
                `address. Skip runs remotely, so calling that back reaches Skip's own container ` +
                `and never this instance — Skip reports it as "unable to reach your server". ` +
                `${REMEDY} ${NOT_A_CREDENTIAL_PROBLEM}`,
        };
    }

    const port = inputs.graphqlPort ?? 4000;
    const rootPath = inputs.graphqlRootPath ?? '/';
    return { ok: true, url: `${baseUrl}:${port}${rootPath}`, source: 'baseUrl' };
}

/**
 * One-line description of a successful resolution, for boot and first-request logs.
 * Names the source so an operator can tell an explicit address from a derived one.
 */
export function describeCallbackURL(resolution: SkipCallbackURLResolution): string {
    if (resolution.ok === false) {
        return resolution.error;
    }
    const from = resolution.source === 'publicUrl'
        ? MJAPI_PUBLIC_URL_ENV_VAR
        : `${GRAPHQL_BASE_URL_ENV_VAR} + GRAPHQL_PORT + GRAPHQL_ROOT_PATH`;
    return `Callback URL advertised to Skip (callingServerURL): ${resolution.url} (from ${from})`;
}
