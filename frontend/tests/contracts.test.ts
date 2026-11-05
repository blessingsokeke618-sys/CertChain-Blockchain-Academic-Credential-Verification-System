import { describe, expect, it } from 'vitest';
import { batchCredentialInputToScVal, describeBatchRowError, normalizeTokenId } from '../src/lib/contracts';

describe('Soroban credential token IDs', () => {
    it('normalizes u64 return values to database-safe token ID strings', () => {
        expect(normalizeTokenId(1)).toBe('1');
        expect(normalizeTokenId(BigInt(42))).toBe('42');
        expect(normalizeTokenId('123')).toBe('123');
    });

    it('rejects missing or non-numeric return values instead of falling back to a transaction hash', () => {
        expect(() => normalizeTokenId(null)).toThrow(/valid token ID/);
        expect(() => normalizeTokenId(undefined)).toThrow(/valid token ID/);
        expect(() => normalizeTokenId('pending')).toThrow(/valid token ID/);
        expect(() => normalizeTokenId('abcdef')).toThrow(/valid token ID/);
    });
});

describe('describeBatchRowError', () => {
    it('maps the known CredentialAlreadyExists code (3) to a specific message', () => {
        expect(describeBatchRowError(3)).toMatch(/already exists/i);
    });

    it('falls back to a generic message for an unrecognized code', () => {
        expect(describeBatchRowError(99)).toBe('Contract error 99');
    });

    it('reports "Unknown error" for a null code', () => {
        expect(describeBatchRowError(null)).toBe('Unknown error');
    });
});

describe('batchCredentialInputToScVal', () => {
    it('encodes struct fields as symbol keys sorted ascending by Rust field name', () => {
        // Soroban's derive_struct macro decodes #[contracttype] structs via a
        // binary_search_by_key over field-name symbols, so the ScMap keys
        // MUST be symbols (not strings) in ascending alphabetical order —
        // credential_hash < ipfs_uri < student — or the contract call traps
        // on the host. This locks that shape down directly against the XDR.
        const scVal = batchCredentialInputToScVal({
            studentAddress: 'GD4CT6FQBUTCG7A3X3QAYXZSZLLJYPMKJNIBD7UCTLKV7MX4XK66OIHU',
            credentialHash: 'a'.repeat(64),
            ipfsUri: 'ipfs://test',
        });

        // stellar-sdk v17: ScVal is a typed class hierarchy. Use constructor.name
        // instead of .switch() and .value (getter) instead of .sym()/.map().
        expect(scVal.constructor.name).toBe('ScValMap');
        const entries = (scVal as unknown as { value: Array<{ key: unknown; val: unknown }> }).value ?? [];
        const keys = entries.map((entry) => {
            const key = entry.key as { constructor: { name: string }; value: string };
            expect(key.constructor.name).toBe('ScValSymbol');
            return key.value;
        });

        expect(keys).toEqual(['credential_hash', 'ipfs_uri', 'student']);
        expect(keys).toEqual([...keys].sort());
    });
});
