#!/usr/bin/env node
/**
 * Generate and verify the OpenAPI 3.0 reference for every Next.js API route (#88).
 *
 *   npm run openapi:generate   # rewrite docs/openapi.json
 *   npm run openapi:check      # fail if the committed spec is stale
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const API_DIR = join(ROOT, 'src/app/api');
const OUT = join(ROOT, 'docs/openapi.json');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function walk(dir) {
    const entries = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) entries.push(...walk(full));
        else if (entry.name === 'route.ts') entries.push(full);
    }
    return entries.sort();
}

function toOpenApiPath(file) {
    const rel = relative(API_DIR, file).replace(/\\/g, '/');
    const segments = rel.split('/').slice(0, -1).map((part) =>
        part.startsWith('[') && part.endsWith(']') ? `{${part.slice(1, -1)}}` : part,
    );
    return `/api/${segments.join('/')}`;
}

function securityFor(path) {
    if (path.startsWith('/api/admin/')) return [{ bearerAuth: [] }, { serviceRole: [] }];
    if (
        path.startsWith('/api/institution/') ||
        path.startsWith('/api/student/') ||
        path.startsWith('/api/account/') ||
        path.startsWith('/api/issuers')
    ) {
        return [{ bearerAuth: [] }];
    }
    if (path.startsWith('/api/cron/')) return [{ cronSecret: [] }];
    if (path.startsWith('/api/claim/') || path.startsWith('/api/contact')) return [];
    return [{ bearerAuth: [] }];
}

function tagFor(path) {
    return path.split('/')[2] ?? 'api';
}

function buildSpec() {
    const paths = {};
    for (const file of walk(API_DIR)) {
        const path = toOpenApiPath(file);
        const source = readFileSync(file, 'utf8');
        const operations = {};
        for (const method of METHODS) {
            const pattern = new RegExp(`export (?:async )?function ${method}\\b`);
            if (!pattern.test(source)) continue;
            const lower = method.toLowerCase();
            const operation = {
                tags: [tagFor(path)],
                summary: `${method} ${path}`,
                operationId: `${lower}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
                security: securityFor(path),
                responses: {
                    '200': { description: 'Successful response' },
                    '400': { description: 'Invalid request' },
                    '401': { description: 'Unauthorized' },
                    '500': { description: 'Server error' },
                },
            };
            if (['post', 'put', 'patch'].includes(lower)) {
                operation.requestBody = {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { type: 'object', additionalProperties: true },
                        },
                    },
                };
            }
            operations[lower] = operation;
        }
        if (Object.keys(operations).length > 0) paths[path] = operations;
    }

    return {
        openapi: '3.0.3',
        info: {
            title: 'Acredia API',
            version: '1.0.0',
            description:
                'Generated reference for every route under src/app/api. Regenerate with npm run openapi:generate after adding or changing a route.',
        },
        servers: [{ url: 'https://acredia-stellar-tau.vercel.app' }],
        paths,
        components: {
            securitySchemes: {
                bearerAuth: { type: 'http', scheme: 'bearer', description: 'Supabase session JWT' },
                serviceRole: { type: 'apiKey', in: 'header', name: 'x-service-role-key' },
                cronSecret: { type: 'apiKey', in: 'header', name: 'x-cron-secret' },
            },
        },
    };
}

const expected = JSON.stringify(buildSpec(), null, 2) + '\n';
if (process.argv.includes('--generate')) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, expected);
    console.log(`Wrote ${relative(ROOT, OUT)} (${Object.keys(JSON.parse(expected).paths).length} paths)`);
    process.exit(0);
}

if (!existsSync(OUT)) {
    console.error('Missing docs/openapi.json. Run npm run openapi:generate.');
    process.exit(1);
}
if (readFileSync(OUT, 'utf8') !== expected) {
    console.error('OpenAPI spec is stale: a route was added, removed or changed.');
    console.error("Run 'npm run openapi:generate' in frontend/ and commit docs/openapi.json.");
    process.exit(1);
}
console.log('OpenAPI spec matches all API routes.');
