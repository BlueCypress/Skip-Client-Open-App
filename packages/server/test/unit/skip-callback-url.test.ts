/**
 * @fileoverview Unit tests for callback-URL resolution.
 *
 * The defect: `getSkipConfig()` defaulted `baseUrl` to `http://localhost`, and the SDK
 * composed `${baseUrl}:${port}${rootPath}` into `callingServerURL` — the address Skip's
 * cloud is asked to dial. Two tenants shipped that value. Skip answered every question
 * with "I'm unable to reach your server ... verify the tunnel is active", which reads as
 * an outage or a bad key, and was diagnosed as a credential problem for days.
 *
 * These tests pin the refusal, and pin the two things that must survive it: an explicit
 * `MJAPI_PUBLIC_URL` is honoured even when it is a loopback address (a brain on the same
 * machine is a real setup), and a host that merely looks loopback-ish is not rejected.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveSkipCallbackURL,
    isLoopbackHost,
    describeCallbackURL,
    MJAPI_PUBLIC_URL_ENV_VAR,
} from '../../src/skip-callback-url.js';

describe('resolveSkipCallbackURL', () => {
    describe('the loopback default is refused, not composed', () => {
        it('refuses the MJServer default base URL when no public URL is set', () => {
            const result = resolveSkipCallbackURL({
                baseUrl: 'http://localhost',
                graphqlPort: 4000,
                graphqlRootPath: '/',
            });

            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('loopback');
                expect(result.rejectedValue).toBe('http://localhost');
            }
        });

        it('never returns a URL containing the loopback host', () => {
            // The composed address `http://localhost:4000/` is what actually went to Skip.
            // No input may produce it except an explicit MJAPI_PUBLIC_URL.
            for (const baseUrl of ['http://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://0.0.0.0']) {
                const result = resolveSkipCallbackURL({ baseUrl, graphqlPort: 4000, graphqlRootPath: '/' });
                expect(result.ok, baseUrl).toBe(false);
            }
        });

        it('refuses when neither variable is set at all', () => {
            const result = resolveSkipCallbackURL({});

            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('unconfigured');
            }
        });

        it('names MJAPI_PUBLIC_URL and rules credentials out, in the message itself', () => {
            // The whole point of the row: the user-visible error must not send anyone to
            // check an API key. The remedy and the exoneration both have to be in the text,
            // because the text is all an operator reading a log line gets.
            const result = resolveSkipCallbackURL({ baseUrl: 'http://localhost' });

            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.error).toContain(MJAPI_PUBLIC_URL_ENV_VAR);
                expect(result.error).toContain('not a credential problem');
            }
        });
    });

    describe('an explicit public URL is honoured', () => {
        it('uses MJAPI_PUBLIC_URL verbatim, without appending port or root path', () => {
            const result = resolveSkipCallbackURL({
                publicUrl: 'https://mjapi.example.com/graphql',
                baseUrl: 'http://localhost',
                graphqlPort: 4000,
                graphqlRootPath: '/',
            });

            expect(result).toEqual({
                ok: true,
                url: 'https://mjapi.example.com/graphql',
                source: 'publicUrl',
            });
        });

        it('honours a loopback MJAPI_PUBLIC_URL — an explicit choice, not an inherited default', () => {
            // A developer running MJAPI and a local brain together needs this to work, and
            // CONFIGURATION.md has always documented localhost as legitimate. The change is
            // that saying so is now required; it is no longer assumed.
            const result = resolveSkipCallbackURL({ publicUrl: 'http://localhost:4000/' });

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.url).toBe('http://localhost:4000/');
            }
        });

        it('refuses a public URL that is not a URL with a host', () => {
            const result = resolveSkipCallbackURL({ publicUrl: 'not a url' });

            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('unparseable');
            }
        });

        it('treats a whitespace-only public URL as unset and falls through to baseUrl', () => {
            const result = resolveSkipCallbackURL({
                publicUrl: '   ',
                baseUrl: 'https://mjapi.example.com',
                graphqlPort: 4000,
                graphqlRootPath: '/',
            });

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.source).toBe('baseUrl');
            }
        });
    });

    describe('a routable base URL still composes', () => {
        it('composes base URL, port and root path', () => {
            const result = resolveSkipCallbackURL({
                baseUrl: 'https://mjapi.example.com',
                graphqlPort: 4000,
                graphqlRootPath: '/graphql',
            });

            expect(result).toEqual({
                ok: true,
                url: 'https://mjapi.example.com:4000/graphql',
                source: 'baseUrl',
            });
        });

        it('falls back to port 4000 and root path / when unset', () => {
            const result = resolveSkipCallbackURL({ baseUrl: 'https://mjapi.example.com' });

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.url).toBe('https://mjapi.example.com:4000/');
            }
        });
    });
});

describe('isLoopbackHost', () => {
    it('matches the loopback forms a deployment can actually inherit', () => {
        for (const host of ['localhost', 'LOCALHOST', 'api.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '::']) {
            expect(isLoopbackHost(host), host).toBe(true);
        }
    });

    it('does not match public hosts that merely contain a loopback-looking substring', () => {
        // A substring test would reject every one of these. The first is a perfectly
        // ordinary public name; the last two resolve to loopback but only because someone
        // deliberately pointed them there, which is their choice to make.
        for (const host of ['localhost.example.com', 'mjapi.example.com', 'not-localhost.io', '127.0.0.1.nip.io']) {
            expect(isLoopbackHost(host), host).toBe(false);
        }
    });
});

describe('describeCallbackURL', () => {
    it('names the source so a derived address is distinguishable from an explicit one', () => {
        const explicit = describeCallbackURL(resolveSkipCallbackURL({ publicUrl: 'https://a.example.com/' }));
        const derived = describeCallbackURL(resolveSkipCallbackURL({ baseUrl: 'https://b.example.com' }));

        expect(explicit).toContain(MJAPI_PUBLIC_URL_ENV_VAR);
        expect(derived).toContain('GRAPHQL_BASE_URL');
    });

    it('returns the refusal text unchanged when there is no URL to describe', () => {
        const resolution = resolveSkipCallbackURL({ baseUrl: 'http://localhost' });

        expect(resolution.ok).toBe(false);
        if (resolution.ok === false) {
            expect(describeCallbackURL(resolution)).toBe(resolution.error);
        }
    });
});
