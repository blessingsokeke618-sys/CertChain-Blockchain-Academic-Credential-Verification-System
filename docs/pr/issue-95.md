# Resolve did:stellar identifiers (#95)

## Summary

Exported VCs contained `did:stellar:<address>` identifiers with no way for third-party OBv3 consumers to resolve them.
This adds a per-address DID document endpoint and documents the resolution algorithm, removing the interop caveat from
the VC documentation.

## What changed

- **`frontend/src/app/api/did/[address]/route.ts`** (new) — validates the G-address, decodes its Ed25519 public key with
  `StrKey`, and returns a DID document with an `Ed25519VerificationKey2020` verification method (multibase base58btc),
  `authentication`, `assertionMethod` and a `LinkedDomains` service endpoint. Malformed addresses return 400.
- **`frontend/tests/didResolver.test.ts`** — covers successful resolution and rejection of malformed identifiers.
- **`docs/verifiable-credentials.md`** — replaced the "no resolver" caveat with the concrete resolution algorithm and
  the remaining caveat (per-address resolver requires configuration; generic did:stellar registration is future work).

## Acceptance criteria addressed

- A `did:stellar:<address>` from an exported VC resolves to a fetchable DID document.
- The VC doc no longer claims the identifier is unresolvable; the interop caveat is scoped to generic method registration.

closes #95
