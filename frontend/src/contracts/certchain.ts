/**
 * CertChainCredential — TypeScript contract bindings
 *
 * Hand-written SDK bindings for the CertChainCredential Soroban contract.
 * These mirror the contract's public ABI exactly (contracts/src/lib.rs) and
 * provide typed wrappers over the raw `simulateTransaction` / `invokeContractMethod`
 * calls elsewhere in the codebase.
 *
 * Generation: when the contract ABI changes, regenerate via:
 *
 *   cd contracts && make bindings
 *
 * That target runs:
 *   stellar contract bindings typescript \
 *     --wasm target/wasm32v1-none/release/acredia_stellar.wasm \
 *     --id <CONTRACT_ID> \
 *     --network testnet \
 *     --output-dir ../frontend/src/contracts
 *
 * Until the CLI-generated output is wired in, these hand-written bindings
 * are the authoritative TypeScript surface for the contract.
 *
 * CONTRACT VERSION: certchain-stellar:2.0.0
 * CONTRACT ID (testnet): CARWFW27MJ3OJADAUAHI3TDFHIL62YMLVEKTUTMSNXOMH7JJTNZKC3DK
 */

// ---------------------------------------------------------------------------
// Contract error codes — mirrors ContractError in lib.rs
// ---------------------------------------------------------------------------

export const ContractErrors = {
    AlreadyInitialized: 1,
    IssuerNotAuthorized: 2,
    CredentialAlreadyExists: 3,
    CredentialNotFound: 4,
    AlreadyRevoked: 5,
    UnauthorizedRevoker: 6,
    NotInitialized: 7,
    SameOwner: 8,
    NoPendingOwner: 9,
    ContractPaused: 10,
    BatchTooLarge: 11,
    EmptyBatch: 12,
    ProfileTooLarge: 13,
    UpgradeNotProposed: 14,
    UpgradeHashMismatch: 15,
    UpgradeTimelockActive: 16,
    IpfsUriTooLarge: 17,
} as const;

export type ContractErrorCode = (typeof ContractErrors)[keyof typeof ContractErrors];

/** Returns a human-readable description for a contract error code. */
export function describeContractError(code: number): string {
    const descriptions: Record<number, string> = {
        [ContractErrors.AlreadyInitialized]: 'Contract is already initialized.',
        [ContractErrors.IssuerNotAuthorized]: 'Issuer is not authorized to issue credentials.',
        [ContractErrors.CredentialAlreadyExists]: 'A credential with this hash already exists.',
        [ContractErrors.CredentialNotFound]: 'Credential not found.',
        [ContractErrors.AlreadyRevoked]: 'Credential has already been revoked.',
        [ContractErrors.UnauthorizedRevoker]: 'Only the original issuer can revoke this credential.',
        [ContractErrors.NotInitialized]: 'Contract has not been initialized.',
        [ContractErrors.SameOwner]: 'New owner is the same as the current owner.',
        [ContractErrors.NoPendingOwner]: 'No pending owner transfer in progress.',
        [ContractErrors.ContractPaused]: 'Contract is paused. No new credentials can be issued.',
        [ContractErrors.BatchTooLarge]: `Batch exceeds the maximum of 20 credentials per call.`,
        [ContractErrors.EmptyBatch]: 'Batch cannot be empty.',
        [ContractErrors.ProfileTooLarge]: 'Issuer profile fields exceed the maximum allowed length.',
        [ContractErrors.UpgradeNotProposed]: 'No upgrade has been proposed.',
        [ContractErrors.UpgradeHashMismatch]: 'Upgrade WASM hash does not match the proposed hash.',
        [ContractErrors.UpgradeTimelockActive]: 'Upgrade timelock has not yet expired (~7 days).',
        [ContractErrors.IpfsUriTooLarge]: 'IPFS URI exceeds the maximum allowed length (512 bytes).',
    };
    return descriptions[code] ?? `Unknown contract error (code ${code}).`;
}

// ---------------------------------------------------------------------------
// Contract constants — mirrors lib.rs
// ---------------------------------------------------------------------------

/** Maximum credentials per batch_issue_credential call. Keep in sync with lib.rs. */
export const MAX_BATCH_SIZE = 20 as const;

/** Maximum length of an IPFS URI stored on-chain. */
export const MAX_IPFS_URI_LEN = 512 as const;

/** Maximum length of an issuer's display name. */
export const MAX_ISSUER_NAME_LEN = 64 as const;

/** Maximum length of an issuer's profile URI. */
export const MAX_ISSUER_PROFILE_URI_LEN = 256 as const;

/** Contract name, as returned by get_contract_info(). */
export const CONTRACT_NAME = 'CertChain Credential' as const;

/** Contract semver, as returned by get_contract_info(). */
export const CONTRACT_VERSION = 'certchain-stellar:2.0.0' as const;

// ---------------------------------------------------------------------------
// Contract data types — mirrors #[contracttype] structs in lib.rs
// ---------------------------------------------------------------------------

/**
 * A credential stored on-chain.
 *
 * Mirrors the `Credential` struct in lib.rs. Field names use snake_case to
 * match the on-chain XDR keys emitted by Soroban's derive macros.
 */
export interface Credential {
    /** Auto-incrementing u64 token ID. Starts at 1. */
    token_id: bigint;
    /** Stellar address of the credential holder. */
    student: string;
    /** Stellar address of the authorized issuer. */
    issuer: string;
    /** 32-byte SHA-256 hash of the canonical credential metadata. */
    credential_hash: Uint8Array;
    /** IPFS URI of the full credential document (≤ MAX_IPFS_URI_LEN bytes). */
    ipfs_hash: string;
    /** Unix timestamp of issuance (from env.ledger().timestamp()). */
    issued_at: bigint;
    /** True if the credential has been revoked. */
    revoked: boolean;
}

/**
 * A single row in a batch_issue_credential call.
 * Mirrors BatchCredentialInput in lib.rs.
 */
export interface BatchCredentialInput {
    student: string;
    credential_hash: Uint8Array;
    ipfs_uri: string;
}

/**
 * Per-row outcome of a batch_issue_credential call.
 * Mirrors BatchIssueResult in lib.rs.
 *
 * On failure: token_id = 0n, error_code = ContractError as u32.
 * On success: error_code = 0.
 */
export interface BatchIssueResult {
    index: number;
    success: boolean;
    token_id: bigint;
    error_code: number;
}

/**
 * On-chain identity binding for an authorized issuer.
 * Mirrors IssuerProfile in lib.rs.
 */
export interface IssuerProfile {
    /** Display name (≤ MAX_ISSUER_NAME_LEN bytes). */
    name: string;
    /** URI to a richer off-chain identity document, e.g. ipfs:// (≤ MAX_ISSUER_PROFILE_URI_LEN bytes). */
    profile_uri: string;
    /** Unix timestamp of the last set_issuer_profile call. */
    updated_at: bigint;
}

/**
 * Static contract metadata returned by get_contract_info().
 * Mirrors ContractInfo in lib.rs.
 */
export interface ContractInfo {
    name: string;
    version: string;
}

/**
 * A pending WASM upgrade.
 * Mirrors PendingUpgrade in lib.rs.
 */
export interface PendingUpgrade {
    wasm_hash: Uint8Array;
    /** The ledger sequence number after which upgrade() may be called. */
    ready_ledger: number;
}

// ---------------------------------------------------------------------------
// Typed event topics — mirrors symbol_short!() event keys in lib.rs
// ---------------------------------------------------------------------------

/**
 * On-chain event topics emitted by the contract.
 *
 * These are the first element of each event's topics vec, as a short symbol.
 * Use these constants when filtering Horizon event streams or Soroban RPC
 * `getEvents` responses for CertChain contract events.
 */
export const ContractEvents = {
    /** Emitted by initialize(). Topics: ["init"], data: owner_address */
    Init: 'init',
    /** Emitted by issue_credential() and each successful batch row. Topics: ["cred_iss", token_id], data: (student, issuer, hash, uri) */
    CredentialIssued: 'cred_iss',
    /** Emitted by batch_issue_credential(). Topics: ["batch_is", issuer], data: (total_rows, succeeded_rows) */
    BatchIssued: 'batch_is',
    /** Emitted by revoke_credential(). Topics: ["cred_rev", token_id], data: issuer_address */
    CredentialRevoked: 'cred_rev',
    /** Emitted by admin_revoke_credential(). Topics: ["cred_rev_owner", token_id], data: owner_address */
    CredentialRevokedByOwner: 'cred_rev_owner',
    /** Emitted by authorize_issuer(). Topics: ["iss_auth"], data: issuer_address */
    IssuerAuthorized: 'iss_auth',
    /** Emitted by revoke_issuer(). Topics: ["iss_rev"], data: issuer_address */
    IssuerRevoked: 'iss_rev',
    /** Emitted by set_issuer_profile(). Topics: ["iss_prof", issuer], data: (name, uri, updated_at) */
    IssuerProfileSet: 'iss_prof',
    /** Emitted by pause(). Topics: ["paused"], data: () */
    Paused: 'paused',
    /** Emitted by unpause(). Topics: ["unpaused"], data: () */
    Unpaused: 'unpaused',
    /** Emitted by propose_upgrade(). Topics: ["upg_prop"], data: (wasm_hash, ready_ledger) */
    UpgradeProposed: 'upg_prop',
    /** Emitted by upgrade(). Topics: ["upgraded"], data: wasm_hash */
    Upgraded: 'upgraded',
    /** Emitted by cancel_upgrade(). Topics: ["upg_cncl"], data: () */
    UpgradeCancelled: 'upg_cncl',
    /** Emitted by migrate(). Topics: ["migrated", from_version], data: to_version */
    Migrated: 'migrated',
    /** Emitted by transfer_owner(). Topics: ["own_xfer", current_owner], data: new_owner */
    OwnerTransferProposed: 'own_xfer',
    /** Emitted by accept_owner(). Topics: ["own_acpt", previous_owner], data: new_owner */
    OwnerTransferAccepted: 'own_acpt',
} as const;

// ---------------------------------------------------------------------------
// Storage key descriptions — for off-chain tooling and indexers
// ---------------------------------------------------------------------------

/**
 * DataKey variants stored on-chain.
 *
 * Use these descriptions when building off-chain indexers or Stellar CLI
 * queries that inspect raw contract state.
 */
export const StorageKeys = {
    /** Instance storage. bool — whether the contract has been initialized. */
    Initialized: 'Initialized',
    /** Instance storage. Address — the current contract owner. */
    Owner: 'Owner',
    /** Instance storage. Address — the pending ownership transfer target. */
    PendingOwner: 'PendingOwner',
    /** Instance storage. u64 — the next token ID to be minted (starts at 1). */
    NextTokenId: 'NextTokenId',
    /** Instance storage. bool — whether the contract is paused. */
    Paused: 'Paused',
    /** Instance storage. PendingUpgrade — a pending WASM upgrade. */
    PendingUpgrade: 'PendingUpgrade',
    /** Instance storage. u32 — the current storage schema version. */
    StorageVersion: 'StorageVersion',
    /**
     * Persistent storage. bool — whether a given Address is an authorized issuer.
     * Key: Authorized(address)
     */
    Authorized: 'Authorized',
    /**
     * Persistent storage. Credential struct — the credential for a given token ID.
     * Key: Credential(token_id: u64)
     */
    Credential: 'Credential',
    /**
     * Persistent storage. u64 — maps a credential hash to its token ID.
     * Key: HashIndex(hash: BytesN<32>)
     */
    HashIndex: 'HashIndex',
    /**
     * Persistent storage. u64 — total credentials ever issued (not counting revoked).
     */
    TotalCredentials: 'TotalCredentials',
    /**
     * Persistent storage. IssuerProfile — the identity binding for an issuer.
     * Key: IssuerProfile(address)
     */
    IssuerProfile: 'IssuerProfile',
    /**
     * Persistent storage. Vec<u64> — list of token IDs issued to a student.
     * Key: StudentIndex(address)
     */
    StudentIndex: 'StudentIndex',
    /**
     * Persistent storage. Vec<u64> — list of token IDs issued by an issuer.
     * Key: IssuerIndex(address)
     */
    IssuerIndex: 'IssuerIndex',
} as const;
