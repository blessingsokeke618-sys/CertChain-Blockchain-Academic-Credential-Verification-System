# Verifiable Credentials

CertChain issues credentials as [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model/)
formatted to comply with the [Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0/) specification.

---

## Why W3C VC / Open Badges 3.0?

- **Interoperability.** Any system that understands OBv3 can consume CertChain credentials
  without a custom integration.
- **Self-describing.** The JSON-LD `@context` tells any processor what each field means.
- **Standard evidence model.** The `evidence` array and `credentialSubject.achievement` map
  directly onto how universities already describe degrees and achievements.
- **Future-proof.** The W3C VC data model is on track to become the global standard for
  digital credentials. Issuing in this format today means no migration later.

---

## Document Structure

A CertChain credential document looks like this (simplified):

```json
{
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json"
  ],
  "id": "urn:certchain:credential:42",
  "type": ["VerifiableCredential", "OpenBadgeCredential"],
  "name": "Bachelor of Computer Science",
  "description": "Awarded to Jane Doe for completion of the BSc Computer Science programme.",
  "issuer": {
    "id": "did:stellar:GAMI3XDDII72W23RADNPPAZ2GYEZ2MTYXLETOU36R4ISXMQ7IURFEKFP",
    "type": ["Profile"],
    "name": "Stellar University"
  },
  "issuanceDate": "2026-06-15",
  "credentialSubject": {
    "id": "did:stellar:GABCDEF...",
    "type": ["AchievementSubject"],
    "name": "Jane Doe",
    "achievement": {
      "id": "urn:certchain:achievement:42",
      "type": ["Achievement"],
      "name": "Bachelor of Computer Science",
      "description": "Three-year undergraduate degree in Computer Science.",
      "achievementType": "Degree",
      "criteria": {
        "narrative": "Completed all required coursework with a GPA of 3.8."
      }
    },
    "result": [
      {
        "type": ["Result"],
        "resultDescription": "Algorithms",
        "value": "92/100 (A)"
      }
    ]
  },
  "evidence": [
    {
      "id": "ipfs://bafybeig...",
      "type": ["Evidence"],
      "name": "Official Transcript",
      "description": "Full academic transcript pinned to IPFS."
    }
  ],
  "credentialData": {
    "studentName": "Jane Doe",
    "studentWallet": "GABCDEF...",
    "degree": "Bachelor of Computer Science",
    "major": "Computer Science",
    "gpa": "3.8",
    "issueDate": "2026-06-15",
    "institutionName": "Stellar University",
    "credentialType": "Degree",
    "subjects": [
      { "id": "sub-1", "name": "Algorithms", "marks": "92", "maxMarks": "100", "grade": "A" }
    ]
  }
}
```

The `credentialData` block is a CertChain-specific extension retained for backward-compatible
internal display (dashboards, search filters). It is not part of the OBv3 standard fields.

---

## On-Chain Hash

The SHA-256 hash stored on the Stellar contract is computed over a **canonical subset** of the
document — not over the full JSON string. This means:

- Adding new fields to the document (e.g. a `credentialStatus` block in a downloaded export)
  does not invalidate old hashes.
- The hash is deterministic regardless of JSON key ordering or whitespace.

### What is hashed (schema v2)

The canonical payload includes these fields in sorted-key JSON with no whitespace:

```
schemaVersion, @context, id, type, name, description, image, issuer.{id,type,name},
issuanceDate, credentialSubject.{id,type,name,achievement.*,result[]},
evidence[], credentialData.*
```

The serialization is `canonicalJson()` in `frontend/src/lib/credentialHash.ts` — an explicit
sorted-key recursive serializer, not `JSON.stringify()`.

### Hash algorithm identifier

Stored on each credential row in Supabase:

| `metadata_schema_version` | `hash_algorithm` | Notes |
|---|---|---|
| `2` | `sha256:canonical-json:v2` | Current, default for new issuances |
| `1` | `sha256:canonical-json:v1` | Previous custom NFT-style shape |
| `0` | `sha256:json-stringify` | Legacy, non-deterministic |

Verification dispatches by the row's stored `metadata_schema_version` and `hash_algorithm` via
`deriveCredentialHash()` in `credentialHash.ts`.

---

## Third-Party Verification Recipe

Any third party can verify a CertChain credential without using the CertChain app:

1. **Fetch the credential document from IPFS.**
   ```
   GET https://gateway.pinata.cloud/ipfs/<CID>
   ```

2. **Compute the SHA-256 hash** over the canonical JSON payload using the schema version
   recorded in the document's `credentialData.schemaVersion` field.

3. **Query the Stellar contract** for the token ID or hash:
   ```
   stellar contract invoke \
     --id CARWFW27MJ3OJADAUAHI3TDFHIL62YMLVEKTUTMSNXOMH7JJTNZKC3DK \
     --network testnet \
     -- verify_credential \
     --credential_hash <32-byte-hex-as-bytes>
   ```
   Or use `get_credential(token_id)` if you have the token ID.

4. **Compare hashes.** If the on-chain `credential_hash` matches your computed hash, the
   document is authentic and has not been tampered with.

5. **Check revocation.** The returned `Credential` struct includes `revoked: bool`. A `true`
   value means the issuer has revoked this credential — it is not valid even if the hash matches.

6. **Verify the issuer.** The `issuer` address in the struct must be authorized:
   ```
   stellar contract invoke ... -- is_authorized_issuer --issuer <ISSUER_ADDRESS>
   ```
   If this returns `false`, the issuer has been de-authorized since issuance — treat with caution.

---

## Field Mapping: Internal → OBv3

| CertChain internal field | OBv3 equivalent |
|---|---|
| `studentName` | `credentialSubject.name` |
| `studentWallet` | `credentialSubject.id` (as `did:stellar:<address>`) |
| `degree` | `credentialSubject.achievement.name` |
| `major` | Appended to `achievement.description` |
| `gpa` | Included in `achievement.criteria.narrative` |
| `issueDate` | `issuanceDate` |
| `institutionName` | `issuer.name` |
| `credentialType` | `credentialSubject.achievement.achievementType` |
| `subjects[].{name,marks,maxMarks,grade}` | `credentialSubject.result[]` |

---

## DID Method

Issuer and student identities are expressed as `did:stellar:<address>`, e.g.:

```
did:stellar:GAMI3XDDII72W23RADNPPAZ2GYEZ2MTYXLETOU36R4ISXMQ7IURFEKFP
```

This is a lightweight convention — there is no registered `did:stellar` DID method resolver
today. A full DID:stellar resolver registration is on the roadmap (Phase 3).
