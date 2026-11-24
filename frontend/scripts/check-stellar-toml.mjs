#!/usr/bin/env node
/**
 * Deploy smoke check for the SEP-0001 discovery document (#96).
 *
 * Usage: DEPLOY_URL=https://example.com npm run check:stellar-toml
 * Defaults to the local dev server. Run the full public validator at
 * https://stellar.expert/validator after this passes.
 */

const base = (process.env.DEPLOY_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const expectedOrgUrl = `${base}/`;
const url = `${base}/.well-known/stellar.toml`;

let response;
try {
    response = await fetch(url, { headers: { accept: 'text/plain' } });
} catch (error) {
    console.error(`Could not fetch ${url}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
}

if (!response.ok) {
    console.error(`stellar.toml returned HTTP ${response.status} at ${url}`);
    console.error('Check the Next.js rewrite from /.well-known/stellar.toml to /stellar.toml.');
    process.exit(1);
}

const document = await response.text();
const field = (name) => document.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];

const failures = [];
if (field('VERSION') !== '2.0') failures.push('VERSION must be "2.0"');

const orgUrl = field('ORG_URL');
if (!orgUrl) failures.push('missing ORG_URL');
else if (orgUrl !== expectedOrgUrl) {
    failures.push(`ORG_URL is "${orgUrl}" but the deployment URL is "${expectedOrgUrl}"`);
}

const signingKey = field('SIGNING_KEY');
if (!signingKey || !/^G[A-Z2-7]{55}$/.test(signingKey)) {
    failures.push('SIGNING_KEY must be a 56-character Stellar public key');
}
if (!document.includes('[[PRINCIPALS]]')) failures.push('missing [[PRINCIPALS]] section');
if (!document.includes('[[CONTRACTS]]')) failures.push('missing [[CONTRACTS]] section');

if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`stellar.toml OK at ${url}`);
console.log(`ORG_URL matches ${expectedOrgUrl}`);
