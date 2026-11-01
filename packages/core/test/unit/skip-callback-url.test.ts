/**
 * @fileoverview Unit tests for the Skip callback URL (`callingServerURL`).
 *
 * Skip Brain calls this MJAPI's GraphQL endpoint at that URL. Behind a CDN that serves the web app
 * at the site root and routes `/api/*` to MJAPI, a bare-origin MJAPI_PUBLIC_URL must get the GraphQL
 * root path appended, or every callback receives the web app's HTML.
 */

import { describe, it, expect } from 'vitest';
import { buildSkipCallbackURL } from '../../src/skip-config.js';

describe('buildSkipCallbackURL', () => {
    it('appends the GraphQL root path to a bare-origin public URL', () => {
        expect(buildSkipCallbackURL({ publicUrl: 'https://aidp-next.bluecypress.io', graphqlRootPath: '/api/' }))
            .toBe('https://aidp-next.bluecypress.io/api/');
    });

    it('treats a trailing slash as a bare origin', () => {
        expect(buildSkipCallbackURL({ publicUrl: 'https://aidp-next.bluecypress.io/', graphqlRootPath: '/api/' }))
            .toBe('https://aidp-next.bluecypress.io/api/');
    });

    it('adds a leading slash to a root path that lacks one', () => {
        expect(buildSkipCallbackURL({ publicUrl: 'https://example.org', graphqlRootPath: 'api/' }))
            .toBe('https://example.org/api/');
    });

    it('keeps a public URL that already names a path', () => {
        expect(buildSkipCallbackURL({ publicUrl: 'https://example.org/graphql', graphqlRootPath: '/api/' }))
            .toBe('https://example.org/graphql');
    });

    it('keeps a bare-origin public URL when GraphQL is served at the root', () => {
        expect(buildSkipCallbackURL({ publicUrl: 'https://abc123.ngrok.io', graphqlRootPath: '/' }))
            .toBe('https://abc123.ngrok.io');
        expect(buildSkipCallbackURL({ publicUrl: 'https://abc123.ngrok.io' }))
            .toBe('https://abc123.ngrok.io');
    });

    it('returns an unparseable public URL unchanged', () => {
        expect(buildSkipCallbackURL({ publicUrl: 'not a url', graphqlRootPath: '/api/' })).toBe('not a url');
    });

    it('falls back to baseUrl:port plus root path without a public URL', () => {
        expect(buildSkipCallbackURL({ baseUrl: 'http://localhost', graphqlPort: 8080, graphqlRootPath: '/api/' }))
            .toBe('http://localhost:8080/api/');
        expect(buildSkipCallbackURL({ publicUrl: '', baseUrl: 'http://localhost', graphqlPort: 4000, graphqlRootPath: '/' }))
            .toBe('http://localhost:4000/');
    });

    it('uses the defaults when nothing is set', () => {
        expect(buildSkipCallbackURL({})).toBe('http://localhost:4000/');
    });
});
