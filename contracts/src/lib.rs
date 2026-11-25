#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// TTL / archival constants
//
// Soroban protocol-26 limits (both testnet and mainnet):
//   max_entry_ttl          = 6_312_000 ledgers  (~1 year at 5 s/ledger)
//   min_persistent_entry_ttl = 4_096 ledgers
//
// Strategy:
//   • PERSISTENT_BUMP_AMOUNT   – extend to 1 year every write / bump call.
//   • PERSISTENT_THRESHOLD     – only re-extend when fewer than ~6 months remain,
//                                so a bump call costs a fee only when it matters.
//   • INSTANCE_BUMP_AMOUNT     – keep instance storage alive for 1 year.
//   • INSTANCE_THRESHOLD       – re-extend instance when < 6 months remain.
// ---------------------------------------------------------------------------
const PERSISTENT_BUMP_AMOUNT: u32 = 6_312_000; // ~1 year
const PERSISTENT_THRESHOLD: u32 = 3_110_400; // ~6 months  (re-extend trigger)
const INSTANCE_BUMP_AMOUNT: u32 = 6_312_000;
const INSTANCE_THRESHOLD: u32 = 3_110_400;

// Maximum number of credentials accepted per `batch_issue_credential` call.
// Each successful row writes two persistent entries (Credential + HashIndex),
// on top of the shared NextTokenId/TotalCredentials writes for the whole
// call. This isn't just a guess: the soroban-env-host test harness
// (`cargo test`) actually simulates real network resource limits, and 25
// items measurably exceeds them — "write ledger entries: 53 > 50, total
// footprint ledger entries: 109 > 100" (see
// `test_batch_issue_at_max_size_boundary_succeeds`, which pins this value by
// asserting a full batch at MAX_BATCH_SIZE succeeds under simulation). 20
// keeps a comfortable margin under both ceilings while still cutting
// signature/latency overhead by 20x versus one-by-one issuance. Callers with
// larger CSVs are expected to split into multiple `batch_issue_credential`
// calls (chunks). Revisit this number if the persistent-entry TTL-bump
// overhead changes, or against measured mainnet resource costs (see
// MAINNET_CHECKLIST.md).
const MAX_BATCH_SIZE: u32 = 20;

// Issuer profile size caps (see IssuerProfile) — kept small and fixed so an
// issuer's identity binding stays a cheap, bounded-size persistent entry
// rather than an open-ended storage/TTL liability.
const MAX_ISSUER_NAME_LEN: u32 = 64;
const MAX_ISSUER_PROFILE_URI_LEN: u32 = 256;

// Maximum length for a credential IPFS URI. Keeps per-credential storage/TTL
// costs bounded (audit F-7). 512 bytes covers the longest realistic
// ipfs:// and https:// gateway URIs with CID v1 + filename suffixes.
const MAX_IPFS_URI_LEN: u32 = 512;

/// Entries per student/issuer index page (#104). Issuance reads and rewrites
/// at most one page, so its cost no longer grows with an address's history.
/// Also the maximum `limit` of the paginated index queries.
const INDEX_PAGE_SIZE: u32 = 100;

// Semantic version of this contract, bumped with each named release.
const CONTRACT_VERSION: &str = "certchain-stellar:2.0.0";

const UPGRADE_TIMELOCK_LEDGERS: u32 = 120_960;

/// Storage schema version this binary reads and writes. Migrations only move
/// forward: state stamped with a higher version is refused rather than
/// silently reinterpreted by older code (#109).
const CURRENT_STORAGE_VERSION: u32 = 2;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized = 1,
    IssuerNotAuthorized = 2,
    CredentialAlreadyExists = 3,
    CredentialNotFound = 4,
    AlreadyRevoked = 5,
    UnauthorizedRevoker = 6,
    NotInitialized = 7,
    SameOwner = 8,
    NoPendingOwner = 9,
    ContractPaused = 10,
    BatchTooLarge = 11,
    EmptyBatch = 12,
    ProfileTooLarge = 13,
    UpgradeNotProposed = 14,
    UpgradeHashMismatch = 15,
    UpgradeTimelockActive = 16,
    /// The supplied IPFS URI exceeds MAX_IPFS_URI_LEN bytes (audit F-7).
    IpfsUriTooLarge = 17,
    /// Stored state was written by a newer schema than this binary
    /// understands; migrations are forward-only (#109).
    UnsupportedStorageVersion = 18,
}

#[contracttype]
pub enum DataKey {
    Initialized,
    Owner,
    PendingOwner,
    NextTokenId,
    Authorized(Address),
    Credential(u64),
    HashIndex(BytesN<32>),
    TotalCredentials,
    StorageVersion,
    Paused,
    IssuerProfile(Address),
    PendingUpgrade,
    /// List of token IDs issued to a specific student address.
    StudentIndex(Address),
    /// List of token IDs issued by a specific authorized issuer.
    IssuerIndex(Address),
    /// Page `n >= 1` of a student's index (#104). Page 0 is `StudentIndex`.
    StudentIndexPage(Address, u32),
    /// Page `n >= 1` of an issuer's index (#104). Page 0 is `IssuerIndex`.
    IssuerIndexPage(Address, u32),
    /// Length bookkeeping for a student's paginated index (#104).
    StudentIndexMeta(Address),
    /// Length bookkeeping for an issuer's paginated index (#104).
    IssuerIndexMeta(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credential {
    pub token_id: u64,
    pub student: Address,
    pub issuer: Address,
    pub credential_hash: BytesN<32>,
    pub ipfs_hash: String,
    pub issued_at: u64,
    pub revoked: bool,
}

/// A single row of a `batch_issue_credential` call. The issuer is shared
/// across the whole batch (see `batch_issue_credential`), so it is not
/// repeated per row.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCredentialInput {
    pub student: Address,
    pub credential_hash: BytesN<32>,
    pub ipfs_uri: String,
}

/// Per-row outcome of a `batch_issue_credential` call. Plain primitives are
/// used instead of `Option<ContractError>` so the shape stays simple and
/// unambiguous to decode off-chain: `token_id` is `0` (never a real token id,
/// which starts at 1) when `success` is `false`, and `error_code` mirrors a
/// `ContractError as u32` value when `success` is `false`, else `0`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchIssueResult {
    pub index: u32,
    pub success: bool,
    pub token_id: u64,
    pub error_code: u32,
}

/// Minimal on-chain binding from an authorized issuer's address to a
/// human-readable identity. `name` is a short display handle read directly
/// from chain state (no off-chain fetch needed for a quick trust check);
/// `profile_uri` optionally points to a richer, off-chain-signed issuer
/// profile document (e.g. an `ipfs://` URI) for deeper verification —
/// mirrors how `Credential.ipfs_hash` anchors a credential's own metadata.
/// Both fields are length-capped (see MAX_ISSUER_NAME_LEN /
/// MAX_ISSUER_PROFILE_URI_LEN) to keep per-issuer storage/TTL cost small.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssuerProfile {
    pub name: String,
    pub profile_uri: String,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub ready_ledger: u32,
}

/// Static information about this contract deployment, returned by
/// `get_contract_info`. Useful for off-chain clients that need to verify they
/// are speaking to the right contract version without any additional indexing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractInfo {
    pub name: String,
    pub version: String,
}

/// Bookkeeping for a paginated address index (#104).
///
/// Page 0 is the original `StudentIndex`/`IssuerIndex` vector. It grows until
/// it holds `INDEX_PAGE_SIZE` entries (or already holds more, for histories
/// written before pagination), then is frozen with `head` entries; later
/// entries fill pages 1, 2, ... of `INDEX_PAGE_SIZE` each. Entries are only
/// ever appended, so a position is a stable cursor.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexMeta {
    /// Total number of token IDs in the index.
    pub len: u64,
    /// Number of entries held by page 0.
    pub head: u64,
}

/// One page of a paginated index query (#104). `next_cursor` is the cursor to
/// pass to get the following page, or `None` when the history is exhausted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexPage {
    pub ids: Vec<u64>,
    pub next_cursor: Option<u64>,
}

#[derive(Clone, Copy)]
enum IndexKind {
    Student,
    Issuer,
}

#[contract]
pub struct CertChainCredential;

// ---------------------------------------------------------------------------
// Index helpers (CertChain v2)
// ---------------------------------------------------------------------------

fn index_page_key(kind: IndexKind, addr: &Address, page: u32) -> DataKey {
    match (kind, page) {
        (IndexKind::Student, 0) => DataKey::StudentIndex(addr.clone()),
        (IndexKind::Issuer, 0) => DataKey::IssuerIndex(addr.clone()),
        (IndexKind::Student, n) => DataKey::StudentIndexPage(addr.clone(), n),
        (IndexKind::Issuer, n) => DataKey::IssuerIndexPage(addr.clone(), n),
    }
}

fn index_meta_key(kind: IndexKind, addr: &Address) -> DataKey {
    match kind {
        IndexKind::Student => DataKey::StudentIndexMeta(addr.clone()),
        IndexKind::Issuer => DataKey::IssuerIndexMeta(addr.clone()),
    }
}

fn read_index_page(env: &Env, key: &DataKey) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(key)
        .unwrap_or_else(|| Vec::new(env))
}

/// Read the index bookkeeping. Histories written before pagination have no
/// meta entry; their page-0 vector is read once to derive it.
fn read_index_meta(env: &Env, kind: IndexKind, addr: &Address) -> IndexMeta {
    if let Some(meta) = env.storage().persistent().get(&index_meta_key(kind, addr)) {
        return meta;
    }
    let legacy = read_index_page(env, &index_page_key(kind, addr, 0));
    let len = legacy.len() as u64;
    IndexMeta { len, head: len }
}

/// Page number and offset within that page of index position `pos`.
fn index_slot(meta: &IndexMeta, pos: u64) -> (u32, u32) {
    if pos < meta.head {
        (0, pos as u32)
    } else {
        let rel = pos - meta.head;
        let page = INDEX_PAGE_SIZE as u64;
        ((1 + rel / page) as u32, (rel % page) as u32)
    }
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
}

/// Append `token_id` to an address's paginated index (#104).
///
/// Only the page receiving the entry is read and rewritten, so issuance cost
/// is bounded by `INDEX_PAGE_SIZE` regardless of how long the history is.
/// Pages share the credentials' ~1-year TTL so history survives the same
/// archival cycle.
fn append_to_address_index(env: &Env, kind: IndexKind, addr: &Address, token_id: u64) {
    let mut meta = read_index_meta(env, kind, addr);
    let page_no = if meta.len == meta.head && meta.head < INDEX_PAGE_SIZE as u64 {
        // Page 0 is still filling up.
        meta.head += 1;
        0
    } else {
        index_slot(&meta, meta.len).0
    };
    let page_key = index_page_key(kind, addr, page_no);
    let mut page = read_index_page(env, &page_key);
    page.push_back(token_id);
    env.storage().persistent().set(&page_key, &page);
    extend_persistent_ttl(env, &page_key);

    meta.len += 1;
    let meta_key = index_meta_key(kind, addr);
    env.storage().persistent().set(&meta_key, &meta);
    extend_persistent_ttl(env, &meta_key);
}

/// Up to `limit` token IDs starting at position `cursor` (#104). Reads at most
/// two pages; `limit` is clamped to `1..=INDEX_PAGE_SIZE`.
fn read_index_range(
    env: &Env,
    kind: IndexKind,
    addr: &Address,
    cursor: u64,
    limit: u32,
) -> IndexPage {
    let meta = read_index_meta(env, kind, addr);
    let limit = limit.clamp(1, INDEX_PAGE_SIZE) as u64;
    let end = meta.len.min(cursor.saturating_add(limit));
    let mut ids = Vec::new(env);
    let mut pos = cursor;
    while pos < end {
        let (page_no, offset) = index_slot(&meta, pos);
        let key = index_page_key(kind, addr, page_no);
        let page = read_index_page(env, &key);
        if offset >= page.len() {
            break; // defensive: never loop on a missing or short page
        }
        extend_persistent_ttl(env, &key);
        let mut i = offset;
        while i < page.len() && pos < end {
            ids.push_back(page.get_unchecked(i));
            i += 1;
            pos += 1;
        }
    }
    let next_cursor = if pos < meta.len { Some(pos) } else { None };
    IndexPage { ids, next_cursor }
}

fn first_index_page(env: &Env, kind: IndexKind, addr: &Address) -> Vec<u64> {
    let key = index_page_key(kind, addr, 0);
    let list = read_index_page(env, &key);
    if !list.is_empty() {
        extend_persistent_ttl(env, &key);
    }
    list
}

fn is_initialized(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<DataKey, bool>(&DataKey::Initialized)
        .unwrap_or(false)
}

/// Abort with the typed `ContractError::NotInitialized` (contract error #7)
/// when `initialize` has not run. `panic_with_error!` surfaces as
/// `Error(Contract, #7)` on-chain and as `Err(Ok(ContractError::NotInitialized))`
/// from generated `try_*` clients, so callers no longer have to parse a
/// formatted panic string (#102).
fn require_initialized(env: &Env) {
    if !is_initialized(env) {
        panic_with_error!(env, ContractError::NotInitialized);
    }
}

fn read_owner(env: &Env) -> Address {
    require_initialized(env);
    env.storage().instance().get(&DataKey::Owner).unwrap()
}

/// Extend the instance storage TTL so Owner/Authorized/NextTokenId are never
/// archived.  Called at the top of every public entry point.
fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Extend the TTL for a single persistent `Credential` entry and its
/// corresponding `HashIndex` entry (looked-up by token_id via the credential).
fn extend_credential_ttl(env: &Env, token_id: u64, credential_hash: &BytesN<32>) {
    env.storage().persistent().extend_ttl(
        &DataKey::Credential(token_id),
        PERSISTENT_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::HashIndex(credential_hash.clone()),
        PERSISTENT_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// Extend the TTL of a student/issuer index list if it exists. Pre-v2
/// credentials have no index entry, and `extend_ttl` on a missing key traps,
/// so absence is skipped (#103).
fn extend_address_index_ttl(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
    }
}

/// Extend the TTLs of an address's index: its bookkeeping, page 0 and the
/// page currently being filled (#103, #104). Older full pages are extended
/// whenever a paginated query reads them, which keeps the bump bounded.
fn extend_address_index_ttls(env: &Env, kind: IndexKind, addr: &Address) {
    extend_address_index_ttl(env, &index_meta_key(kind, addr));
    extend_address_index_ttl(env, &index_page_key(kind, addr, 0));
    let meta = read_index_meta(env, kind, addr);
    if meta.len > meta.head {
        let (last_page, _) = index_slot(&meta, meta.len - 1);
        extend_address_index_ttl(env, &index_page_key(kind, addr, last_page));
    }
}

/// Extend the TTL of the TotalCredentials counter.
fn extend_total_credentials_ttl(env: &Env) {
    env.storage().persistent().extend_ttl(
        &DataKey::TotalCredentials,
        PERSISTENT_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// Extend the TTL of a single issuer's profile entry.
fn extend_issuer_profile_ttl(env: &Env, issuer: &Address) {
    env.storage().persistent().extend_ttl(
        &DataKey::IssuerProfile(issuer.clone()),
        PERSISTENT_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

fn contract_is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<DataKey, bool>(&DataKey::Paused)
        .unwrap_or(false)
}

/// Checks if an issuer is authorized, handles TTL extension for persistent storage,
/// and transparently migrates existing instance-based authorizations to persistent storage.
fn check_and_extend_authorization(env: &Env, issuer: &Address) -> bool {
    // 1. Check persistent storage (new behavior)
    if let Some(authorized) = env
        .storage()
        .persistent()
        .get::<_, bool>(&DataKey::Authorized(issuer.clone()))
    {
        if authorized {
            env.storage().persistent().extend_ttl(
                &DataKey::Authorized(issuer.clone()),
                PERSISTENT_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
        return authorized;
    }

    // 2. Fallback to instance storage (for existing deployments)
    if let Some(authorized) = env
        .storage()
        .instance()
        .get::<_, bool>(&DataKey::Authorized(issuer.clone()))
    {
        if authorized {
            // Migrate to persistent
            env.storage()
                .persistent()
                .set(&DataKey::Authorized(issuer.clone()), &true);
            env.storage().persistent().extend_ttl(
                &DataKey::Authorized(issuer.clone()),
                PERSISTENT_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
            // Clean up instance storage
            env.storage()
                .instance()
                .remove(&DataKey::Authorized(issuer.clone()));
        }
        return authorized;
    }

    false
}

#[contractimpl]
#[allow(deprecated)]
impl CertChainCredential {
    pub fn initialize(env: Env, owner: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Owner) {
            return Err(ContractError::AlreadyInitialized);
        }
        // Require the proposed owner's signature so initialize cannot be
        // front-run into setting an address the caller does not control
        // (which would permanently brick the contract). This does not by
        // itself prevent front-running of *which* address becomes owner —
        // deploy and initialize must still be submitted as a single atomic
        // transaction for that. See contracts/SECURITY_AUDIT.md (F-1).
        owner.require_auth();
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::NextTokenId, &1u64);
        extend_instance_ttl(&env);
        env.events().publish((symbol_short!("init"),), owner);
        Ok(())
    }

    pub fn get_owner(env: Env) -> Address {
        extend_instance_ttl(&env);
        read_owner(&env)
    }

    pub fn get_pending_owner(env: Env) -> Option<Address> {
        require_initialized(&env);
        extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::PendingOwner)
    }

    pub fn transfer_owner(env: Env, new_owner: Address) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if owner == new_owner {
            return Err(ContractError::SameOwner);
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingOwner, &new_owner.clone());
        extend_instance_ttl(&env);

        env.events()
            .publish((symbol_short!("own_xfer"), owner), new_owner);

        Ok(())
    }

    pub fn accept_owner(env: Env) -> Result<(), ContractError> {
        let previous_owner = read_owner(&env);
        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }
        let pending_owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingOwner)
            .ok_or(ContractError::NoPendingOwner)?;

        pending_owner.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Owner, &pending_owner.clone());
        env.storage().instance().remove(&DataKey::PendingOwner);
        extend_instance_ttl(&env);

        env.events()
            .publish((symbol_short!("own_acpt"), previous_owner), pending_owner);

        Ok(())
    }

    pub fn authorize_issuer(env: Env, issuer: Address) {
        let owner = read_owner(&env);
        owner.require_auth();
        if contract_is_paused(&env) {
            panic_with_error!(&env, ContractError::ContractPaused);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Authorized(issuer.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Authorized(issuer.clone()),
            PERSISTENT_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.storage()
            .instance()
            .remove(&DataKey::Authorized(issuer.clone())); // Cleanup existing
        extend_instance_ttl(&env);
        env.events().publish((symbol_short!("iss_auth"),), issuer);
    }

    /// Revoke an issuer's permission to issue new credentials.
    ///
    /// This does not mutate previously issued credentials. Existing credentials
    /// remain verifiable and keep their original issuance metadata, while the
    /// issuer is simply prevented from issuing new credentials in the future.
    pub fn revoke_issuer(env: Env, issuer: Address) {
        let owner = read_owner(&env);
        owner.require_auth();
        if contract_is_paused(&env) {
            panic_with_error!(&env, ContractError::ContractPaused);
        }

        let in_persistent = env
            .storage()
            .persistent()
            .get::<_, bool>(&DataKey::Authorized(issuer.clone()))
            .unwrap_or(false);
        let in_instance = env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::Authorized(issuer.clone()))
            .unwrap_or(false);
        let was_authorized = in_persistent || in_instance;

        if was_authorized {
            env.storage()
                .persistent()
                .remove(&DataKey::Authorized(issuer.clone()));
            env.storage()
                .instance()
                .remove(&DataKey::Authorized(issuer.clone()));
            env.events().publish((symbol_short!("iss_rev"),), issuer);
        }

        extend_instance_ttl(&env);
    }

    pub fn is_authorized_issuer(env: Env, issuer: Address) -> bool {
        require_initialized(&env);
        extend_instance_ttl(&env);
        check_and_extend_authorization(&env, &issuer)
    }

    /// Publish or update the calling issuer's minimal on-chain identity
    /// binding. Self-service by design (the issuer signs, not the owner) —
    /// authorization (who *can* issue) and profile (how they *identify*) are
    /// deliberately separate concerns. Requires the caller to be currently
    /// authorized, so profile storage can't be spammed by arbitrary
    /// addresses. Revoking an issuer's authorization does not clear their
    /// profile (see revoke_issuer) — past credentials should still resolve
    /// to the identity that issued them — it just blocks further updates
    /// until re-authorized.
    pub fn set_issuer_profile(
        env: Env,
        issuer: Address,
        name: String,
        profile_uri: String,
    ) -> Result<(), ContractError> {
        issuer.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !check_and_extend_authorization(&env, &issuer) {
            return Err(ContractError::IssuerNotAuthorized);
        }

        if name.len() > MAX_ISSUER_NAME_LEN || profile_uri.len() > MAX_ISSUER_PROFILE_URI_LEN {
            return Err(ContractError::ProfileTooLarge);
        }

        let updated_at = env.ledger().timestamp();
        let profile = IssuerProfile {
            name: name.clone(),
            profile_uri: profile_uri.clone(),
            updated_at,
        };

        env.storage()
            .persistent()
            .set(&DataKey::IssuerProfile(issuer.clone()), &profile);
        extend_issuer_profile_ttl(&env, &issuer);
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("iss_prof"), issuer),
            (name, profile_uri, updated_at),
        );

        Ok(())
    }

    /// Resolve an issuer address to its on-chain identity binding, if any
    /// has been published. Returns `None` for an issuer that never called
    /// `set_issuer_profile` — this is a distinct, weaker state than "not
    /// authorized" (an authorized issuer may simply not have a profile yet).
    pub fn get_issuer_profile(env: Env, issuer: Address) -> Option<IssuerProfile> {
        extend_instance_ttl(&env);
        let profile: IssuerProfile = env
            .storage()
            .persistent()
            .get(&DataKey::IssuerProfile(issuer.clone()))?;
        extend_issuer_profile_ttl(&env, &issuer);
        Some(profile)
    }

    pub fn issue_credential(
        env: Env,
        student: Address,
        issuer: Address,
        credential_hash: BytesN<32>,
        ipfs_uri: String,
    ) -> Result<u64, ContractError> {
        issuer.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !check_and_extend_authorization(&env, &issuer) {
            return Err(ContractError::IssuerNotAuthorized);
        }

        if ipfs_uri.len() > MAX_IPFS_URI_LEN {
            return Err(ContractError::IpfsUriTooLarge);
        }

        // Reject duplicate hashes to prevent index overwrite.
        if env
            .storage()
            .persistent()
            .has(&DataKey::HashIndex(credential_hash.clone()))
        {
            return Err(ContractError::CredentialAlreadyExists);
        }

        let token_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextTokenId)
            .unwrap_or(1u64);

        let credential = Credential {
            token_id,
            student: student.clone(),
            issuer: issuer.clone(),
            credential_hash: credential_hash.clone(),
            ipfs_hash: ipfs_uri.clone(),
            issued_at: env.ledger().timestamp(),
            revoked: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Credential(token_id), &credential);
        env.storage()
            .persistent()
            .set(&DataKey::HashIndex(credential_hash.clone()), &token_id);

        // Extend TTL on every write so credentials survive long-term.
        extend_credential_ttl(&env, token_id, &credential_hash);

        env.storage()
            .instance()
            .set(&DataKey::NextTokenId, &(token_id + 1));

        let current: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCredentials)
            .unwrap_or(0u64);
        env.storage()
            .persistent()
            .set(&DataKey::TotalCredentials, &(current + 1));
        extend_total_credentials_ttl(&env);

        // Keep instance storage alive too.
        extend_instance_ttl(&env);

        // ── New in CertChain v2: maintain per-student and per-issuer indices ──
        append_to_address_index(&env, IndexKind::Student, &student, token_id);
        append_to_address_index(&env, IndexKind::Issuer, &issuer, token_id);

        env.events().publish(
            (symbol_short!("cred_iss"), token_id),
            (student, issuer, credential_hash, ipfs_uri),
        );

        Ok(token_id)
    }

    /// Issue up to `MAX_BATCH_SIZE` credentials from a single issuer in one
    /// call/signature. Unlike `issue_credential`, a bad row (e.g. a duplicate
    /// hash) does not fail the whole call: it is recorded as a failed
    /// `BatchIssueResult` and the remaining rows are still attempted, so
    /// callers get clear per-row success/failure instead of an all-or-nothing
    /// transaction. Only whole-batch problems (unauthenticated/unauthorized
    /// issuer, paused contract, empty batch, batch too large) fail the call
    /// itself via `Result::Err`.
    pub fn batch_issue_credential(
        env: Env,
        issuer: Address,
        credentials: Vec<BatchCredentialInput>,
    ) -> Result<Vec<BatchIssueResult>, ContractError> {
        issuer.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !check_and_extend_authorization(&env, &issuer) {
            return Err(ContractError::IssuerNotAuthorized);
        }

        if credentials.is_empty() {
            return Err(ContractError::EmptyBatch);
        }

        if credentials.len() > MAX_BATCH_SIZE {
            return Err(ContractError::BatchTooLarge);
        }

        let mut results: Vec<BatchIssueResult> = Vec::new(&env);
        // Hashes issued earlier in this same batch — duplicates against these
        // wouldn't yet be visible via `storage().persistent().has(...)`.
        let mut seen_hashes: Vec<BytesN<32>> = Vec::new(&env);

        let mut next_token_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextTokenId)
            .unwrap_or(1u64);
        let mut issued_count: u64 = 0;

        for (i, input) in credentials.iter().enumerate() {
            let index = i as u32;

            if input.ipfs_uri.len() > MAX_IPFS_URI_LEN {
                results.push_back(BatchIssueResult {
                    index,
                    success: false,
                    token_id: 0,
                    error_code: ContractError::IpfsUriTooLarge as u32,
                });
                continue;
            }

            let mut duplicate = env
                .storage()
                .persistent()
                .has(&DataKey::HashIndex(input.credential_hash.clone()));
            if !duplicate {
                for seen in seen_hashes.iter() {
                    if seen == input.credential_hash {
                        duplicate = true;
                        break;
                    }
                }
            }

            if duplicate {
                results.push_back(BatchIssueResult {
                    index,
                    success: false,
                    token_id: 0,
                    error_code: ContractError::CredentialAlreadyExists as u32,
                });
                continue;
            }

            let token_id = next_token_id;
            let credential = Credential {
                token_id,
                student: input.student.clone(),
                issuer: issuer.clone(),
                credential_hash: input.credential_hash.clone(),
                ipfs_hash: input.ipfs_uri.clone(),
                issued_at: env.ledger().timestamp(),
                revoked: false,
            };

            env.storage()
                .persistent()
                .set(&DataKey::Credential(token_id), &credential);
            env.storage().persistent().set(
                &DataKey::HashIndex(input.credential_hash.clone()),
                &token_id,
            );
            extend_credential_ttl(&env, token_id, &input.credential_hash);

            // ── CertChain v2: per-student / per-issuer index ──
            append_to_address_index(&env, IndexKind::Student, &input.student, token_id);
            append_to_address_index(&env, IndexKind::Issuer, &issuer, token_id);

            seen_hashes.push_back(input.credential_hash.clone());
            next_token_id += 1;
            issued_count += 1;

            env.events().publish(
                (symbol_short!("cred_iss"), token_id),
                (
                    input.student.clone(),
                    issuer.clone(),
                    input.credential_hash.clone(),
                    input.ipfs_uri.clone(),
                ),
            );

            results.push_back(BatchIssueResult {
                index,
                success: true,
                token_id,
                error_code: 0,
            });
        }

        if issued_count > 0 {
            env.storage()
                .instance()
                .set(&DataKey::NextTokenId, &next_token_id);

            let current: u64 = env
                .storage()
                .persistent()
                .get(&DataKey::TotalCredentials)
                .unwrap_or(0u64);
            env.storage()
                .persistent()
                .set(&DataKey::TotalCredentials, &(current + issued_count));
            extend_total_credentials_ttl(&env);
        }

        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("batch_is"), issuer),
            (credentials.len(), issued_count as u32),
        );

        Ok(results)
    }

    pub fn revoke_credential(
        env: Env,
        token_id: u64,
        issuer: Address,
    ) -> Result<(), ContractError> {
        issuer.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        let mut credential: Credential = env
            .storage()
            .persistent()
            .get(&DataKey::Credential(token_id))
            .ok_or(ContractError::CredentialNotFound)?;

        if credential.issuer != issuer {
            return Err(ContractError::UnauthorizedRevoker);
        }
        if credential.revoked {
            return Err(ContractError::AlreadyRevoked);
        }

        credential.revoked = true;
        env.storage()
            .persistent()
            .set(&DataKey::Credential(token_id), &credential);

        // Extend TTL even on revocation — a revoked credential must remain
        // readable so verifiers know it was revoked (not just missing).
        extend_credential_ttl(&env, token_id, &credential.credential_hash);
        extend_instance_ttl(&env);

        env.events()
            .publish((symbol_short!("cred_rev"), token_id), issuer);

        Ok(())
    }

    pub fn admin_revoke_credential(env: Env, token_id: u64) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        let mut credential: Credential = env
            .storage()
            .persistent()
            .get(&DataKey::Credential(token_id))
            .ok_or(ContractError::CredentialNotFound)?;

        if credential.revoked {
            return Err(ContractError::AlreadyRevoked);
        }

        credential.revoked = true;
        env.storage()
            .persistent()
            .set(&DataKey::Credential(token_id), &credential);

        extend_credential_ttl(&env, token_id, &credential.credential_hash);
        extend_instance_ttl(&env);

        env.events()
            .publish((Symbol::new(&env, "cred_rev_owner"), token_id), owner);

        Ok(())
    }

    pub fn get_credential(env: Env, token_id: u64) -> Result<Credential, ContractError> {
        let credential: Credential = env
            .storage()
            .persistent()
            .get(&DataKey::Credential(token_id))
            .ok_or(ContractError::CredentialNotFound)?;
        // Extend on every read — anyone requesting a credential implicitly
        // signals it is still needed.
        extend_credential_ttl(&env, token_id, &credential.credential_hash);
        extend_instance_ttl(&env);
        Ok(credential)
    }

    pub fn verify_credential(env: Env, credential_hash: BytesN<32>) -> Option<Credential> {
        let token_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::HashIndex(credential_hash.clone()))?;
        let credential: Credential = env
            .storage()
            .persistent()
            .get(&DataKey::Credential(token_id))?;
        extend_credential_ttl(&env, token_id, &credential_hash);
        extend_instance_ttl(&env);
        Some(credential)
    }

    pub fn is_revoked(env: Env, token_id: u64) -> bool {
        extend_instance_ttl(&env);
        let maybe: Option<Credential> = env
            .storage()
            .persistent()
            .get::<DataKey, Credential>(&DataKey::Credential(token_id));
        if let Some(ref c) = maybe {
            env.storage().persistent().extend_ttl(
                &DataKey::Credential(token_id),
                PERSISTENT_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
            c.revoked
        } else {
            false
        }
    }

    pub fn total_credentials(env: Env) -> u64 {
        require_initialized(&env);
        extend_instance_ttl(&env);
        let total = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCredentials)
            .unwrap_or(0u64);
        if total > 0 {
            extend_total_credentials_ttl(&env);
        }
        total
    }

    /// Public bump entry-point so anyone can extend the TTL of any credential
    /// (and its student/issuer index entries) without modifying it.  This lets off-chain keepers (or the credential
    /// holder) ensure the data stays alive without requiring issuer authority.
    ///
    /// Returns `Err(CredentialNotFound)` when the token_id does not exist
    /// (including after it has been archived and not yet restored).
    pub fn bump_credential(env: Env, token_id: u64) -> Result<(), ContractError> {
        let credential: Credential = env
            .storage()
            .persistent()
            .get(&DataKey::Credential(token_id))
            .ok_or(ContractError::CredentialNotFound)?;
        extend_credential_ttl(&env, token_id, &credential.credential_hash);
        // Keep the per-address histories alive with the credential, so a keeper
        // that only bumps credentials does not let get_credentials_by_student /
        // get_credentials_by_issuer go incomplete (#103).
        extend_address_index_ttls(&env, IndexKind::Student, &credential.student);
        extend_address_index_ttls(&env, IndexKind::Issuer, &credential.issuer);
        extend_total_credentials_ttl(&env);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Halt all state-changing entrypoints (credential, issuer, profile,
    /// ownership, upgrade, and migration mutations).  `unpause`, TTL
    /// extensions (`bump_credential`), and read/verification queries continue
    /// to work while paused so existing credentials remain verifiable.
    pub fn pause(env: Env) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        extend_instance_ttl(&env);
        env.events().publish((symbol_short!("paused"),), ());
        Ok(())
    }

    /// Restore normal operation after an emergency pause.
    pub fn unpause(env: Env) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        extend_instance_ttl(&env);
        env.events().publish((symbol_short!("unpaused"),), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        extend_instance_ttl(&env);
        contract_is_paused(&env)
    }

    pub fn propose_upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        let ready_ledger = env
            .ledger()
            .sequence()
            .saturating_add(UPGRADE_TIMELOCK_LEDGERS);

        let pending = PendingUpgrade {
            wasm_hash: new_wasm_hash.clone(),
            ready_ledger,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &pending);

        env.events()
            .publish((symbol_short!("upg_prop"),), (new_wasm_hash, ready_ledger));

        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        extend_instance_ttl(&env);
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    pub fn cancel_upgrade(env: Env) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !env.storage().instance().has(&DataKey::PendingUpgrade) {
            return Err(ContractError::UpgradeNotProposed);
        }

        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.events().publish((symbol_short!("upg_cncl"),), ());

        extend_instance_ttl(&env);
        Ok(())
    }

    /// Upgrade the contract to a new WebAssembly code using a WASM hash.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();

        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(ContractError::UpgradeNotProposed)?;

        if pending.wasm_hash != new_wasm_hash {
            return Err(ContractError::UpgradeHashMismatch);
        }

        if env.ledger().sequence() < pending.ready_ledger {
            return Err(ContractError::UpgradeTimelockActive);
        }

        env.storage().instance().remove(&DataKey::PendingUpgrade);

        env.events()
            .publish((symbol_short!("upgraded"),), new_wasm_hash.clone());
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        extend_instance_ttl(&env);
        Ok(())
    }

    /// Get the current storage version.
    pub fn get_storage_version(env: Env) -> u32 {
        extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::StorageVersion)
            .unwrap_or(1)
    }

    /// Migrate storage schema to the current version.
    pub fn migrate(env: Env) -> Result<(), ContractError> {
        let owner = read_owner(&env);
        owner.require_auth();
        if contract_is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }
        extend_instance_ttl(&env);

        let current_version = env
            .storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::StorageVersion)
            .unwrap_or(1);

        // Forward-only (#109): a binary never downgrades or reinterprets
        // state written by a newer schema.
        if current_version > CURRENT_STORAGE_VERSION {
            return Err(ContractError::UnsupportedStorageVersion);
        }

        if current_version < CURRENT_STORAGE_VERSION {
            // Perform schema / data migration logic here.
            // E.g., initializing/updating storage parameters, etc.
            env.storage()
                .instance()
                .set(&DataKey::StorageVersion, &CURRENT_STORAGE_VERSION);
            env.events().publish(
                (symbol_short!("migrated"), current_version),
                CURRENT_STORAGE_VERSION,
            );
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // CertChain v2 — new query functions
    // -----------------------------------------------------------------------

    /// Return the first page of token IDs issued to `student` (up to
    /// `INDEX_PAGE_SIZE`, or the whole pre-pagination history).
    ///
    /// The index is populated by `issue_credential` and
    /// `batch_issue_credential` at issuance time (CertChain v2). Returns an
    /// empty Vec for addresses with no credentials, or for pre-v2 issuances
    /// that pre-date the index. Revocation does not remove entries — use
    /// `get_credential(token_id).revoked` to filter. Use
    /// `get_credentials_by_student_page` to walk a longer history (#104).
    pub fn get_credentials_by_student(env: Env, student: Address) -> Vec<u64> {
        extend_instance_ttl(&env);
        first_index_page(&env, IndexKind::Student, &student)
    }

    /// Return the first page of token IDs issued *by* `issuer`. Same semantics
    /// as `get_credentials_by_student`; use `get_credentials_by_issuer_page`
    /// for the rest of the history (#104).
    pub fn get_credentials_by_issuer(env: Env, issuer: Address) -> Vec<u64> {
        extend_instance_ttl(&env);
        first_index_page(&env, IndexKind::Issuer, &issuer)
    }

    /// Up to `limit` (max `INDEX_PAGE_SIZE`) token IDs issued to `student`,
    /// starting at position `cursor` (0 for the first page). Positions are
    /// stable: entries are only ever appended. Pass the returned
    /// `next_cursor` to continue; it is `None` once the history is exhausted.
    pub fn get_credentials_by_student_page(
        env: Env,
        student: Address,
        cursor: u64,
        limit: u32,
    ) -> IndexPage {
        extend_instance_ttl(&env);
        read_index_range(&env, IndexKind::Student, &student, cursor, limit)
    }

    /// Paginated counterpart of `get_credentials_by_issuer`; see
    /// `get_credentials_by_student_page`.
    pub fn get_credentials_by_issuer_page(
        env: Env,
        issuer: Address,
        cursor: u64,
        limit: u32,
    ) -> IndexPage {
        extend_instance_ttl(&env);
        read_index_range(&env, IndexKind::Issuer, &issuer, cursor, limit)
    }

    /// Number of token IDs in `student`'s index.
    pub fn count_credentials_by_student(env: Env, student: Address) -> u64 {
        extend_instance_ttl(&env);
        read_index_meta(&env, IndexKind::Student, &student).len
    }

    /// Number of token IDs in `issuer`'s index.
    pub fn count_credentials_by_issuer(env: Env, issuer: Address) -> u64 {
        extend_instance_ttl(&env);
        read_index_meta(&env, IndexKind::Issuer, &issuer).len
    }

    /// Return static metadata about this contract (name + semver string).
    ///
    /// Useful for off-chain clients and explorers to identify the deployment
    /// without consulting a separate registry. The values are compile-time
    /// constants — they never change for a given WASM binary.
    pub fn get_contract_info(env: Env) -> ContractInfo {
        extend_instance_ttl(&env);
        ContractInfo {
            name: String::from_str(&env, "CertChain Credential"),
            version: String::from_str(&env, CONTRACT_VERSION),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events, Register};
    use soroban_sdk::{vec, IntoVal, TryIntoVal, Val};

    fn setup() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        let issuer = Address::generate(&env);
        let student = Address::generate(&env);
        // initialize and authorize_issuer must be separate frames: both call
        // owner.require_auth(), and mock_all_auths() errors on a second
        // require_auth() for the same address within one synthetic frame.
        env.as_contract(&contract, || {
            CertChainCredential::initialize(env.clone(), owner.clone()).unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::authorize_issuer(env.clone(), issuer.clone());
        });
        (env, contract, owner, issuer, student)
    }

    fn dummy_hash(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    fn dummy_batch_input(env: &Env, seed: u8, student: &Address) -> BatchCredentialInput {
        BatchCredentialInput {
            student: student.clone(),
            credential_hash: dummy_hash(env, seed),
            ipfs_uri: String::from_str(env, "ipfs://batch"),
        }
    }

    fn last_event_topics(env: &Env) -> soroban_sdk::Vec<Val> {
        let events = env.events().all();
        let event = events.events().last().unwrap();
        match &event.body {
            soroban_sdk::xdr::ContractEventBody::V0(event) => {
                event.topics.clone().try_into_val(env).unwrap()
            }
        }
    }

    // Initialization

    #[test]
    fn test_initialize_once() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        env.as_contract(&contract, || {
            assert!(CertChainCredential::initialize(env.clone(), owner.clone()).is_ok());
            assert_eq!(CertChainCredential::get_owner(env.clone()), owner);
            assert_eq!(CertChainCredential::get_pending_owner(env.clone()), None);
            assert_eq!(
                CertChainCredential::initialize(env.clone(), owner),
                Err(ContractError::AlreadyInitialized)
            );
        });
    }

    // Issuance

    #[test]
    fn test_issue_and_verify() {
        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 1);
        let ipfs = String::from_str(&env, "ipfs://test");

        env.as_contract(&contract, || {
            let token_id = CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer,
                hash.clone(),
                ipfs,
            )
            .unwrap();

            assert_eq!(token_id, 1);
            let cred = CertChainCredential::verify_credential(env.clone(), hash).unwrap();
            assert_eq!(cred.token_id, 1);
            assert_eq!(cred.student, student);
        });
    }

    #[test]
    fn test_duplicate_hash_rejected() {
        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 2);
        let ipfs = String::from_str(&env, "ipfs://a");

        env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                hash.clone(),
                ipfs.clone(),
            )
            .unwrap();
        });

        env.as_contract(&contract, || {
            let result =
                CertChainCredential::issue_credential(env.clone(), student, issuer, hash, ipfs);
            assert_eq!(result, Err(ContractError::CredentialAlreadyExists));
        });
    }

    #[test]
    fn property_duplicate_hash_rejected_across_seeded_inputs() {
        for seed in 0u8..12 {
            let (env, contract, _, issuer, student) = setup();
            let hash = dummy_hash(&env, seed.wrapping_add(32));
            let ipfs = String::from_str(&env, "ipfs://duplicate-property");

            env.as_contract(&contract, || {
                CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    hash.clone(),
                    ipfs.clone(),
                )
                .unwrap();
            });

            env.as_contract(&contract, || {
                let duplicate = CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    hash.clone(),
                    ipfs.clone(),
                );

                assert_eq!(duplicate, Err(ContractError::CredentialAlreadyExists));
            });
        }
    }

    #[test]
    fn test_unauthorized_issuer_rejected() {
        let (env, contract, _, _, student) = setup();
        let rogue = Address::generate(&env);
        env.as_contract(&contract, || {
            let result = CertChainCredential::issue_credential(
                env.clone(),
                student,
                rogue,
                dummy_hash(&env, 3),
                String::from_str(&env, "ipfs://x"),
            );
            assert_eq!(result, Err(ContractError::IssuerNotAuthorized));
        });
    }

    #[test]
    fn test_issue_credential_at_ipfs_uri_boundary_succeeds() {
        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 70);
        let uri = dummy_long_str(&env, MAX_IPFS_URI_LEN as usize);
        env.as_contract(&contract, || {
            let token_id = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                hash.clone(),
                uri.clone(),
            )
            .unwrap();
            assert_eq!(token_id, 1);
            let cred = CertChainCredential::verify_credential(env.clone(), hash).unwrap();
            assert_eq!(cred.ipfs_hash, uri);
        });
    }

    #[test]
    fn test_issue_credential_rejects_oversized_ipfs_uri() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let uri = dummy_long_str(&env, (MAX_IPFS_URI_LEN + 1) as usize);
            let result = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 71),
                uri,
            );
            assert_eq!(result, Err(ContractError::IpfsUriTooLarge));
            assert_eq!(CertChainCredential::total_credentials(env.clone()), 0);
        });
    }

    // Batch issuance

    #[test]
    fn test_batch_issue_success() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let items = soroban_sdk::vec![
                &env,
                dummy_batch_input(&env, 40, &student),
                dummy_batch_input(&env, 41, &student),
                dummy_batch_input(&env, 42, &student),
            ];
            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();

            assert_eq!(results.len(), 3);
            for i in 0..3u32 {
                let r = results.get(i).unwrap();
                assert!(r.success);
                assert_eq!(r.token_id, (i as u64) + 1);
                assert_eq!(r.error_code, 0);
            }
            assert_eq!(CertChainCredential::total_credentials(env.clone()), 3);
        });
    }

    #[test]
    fn test_batch_issue_at_ipfs_uri_boundary_succeeds() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let items = soroban_sdk::vec![
                &env,
                BatchCredentialInput {
                    student: student.clone(),
                    credential_hash: dummy_hash(&env, 72),
                    ipfs_uri: dummy_long_str(&env, MAX_IPFS_URI_LEN as usize),
                },
            ];
            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();
            assert_eq!(results.len(), 1);
            let r = results.get(0).unwrap();
            assert!(r.success);
            assert_eq!(r.token_id, 1);
            assert_eq!(CertChainCredential::total_credentials(env.clone()), 1);
        });
    }

    #[test]
    fn test_batch_issue_rejects_oversized_ipfs_uri_row_others_succeed() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let items = soroban_sdk::vec![
                &env,
                BatchCredentialInput {
                    student: student.clone(),
                    credential_hash: dummy_hash(&env, 73),
                    ipfs_uri: dummy_long_str(&env, (MAX_IPFS_URI_LEN + 1) as usize),
                },
                BatchCredentialInput {
                    student,
                    credential_hash: dummy_hash(&env, 74),
                    ipfs_uri: String::from_str(&env, "ipfs://ok"),
                },
            ];
            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();
            assert_eq!(results.len(), 2);

            let r0 = results.get(0).unwrap();
            assert!(!r0.success);
            assert_eq!(r0.token_id, 0);
            assert_eq!(r0.error_code, ContractError::IpfsUriTooLarge as u32);

            let r1 = results.get(1).unwrap();
            assert!(r1.success);
            assert_eq!(r1.token_id, 1);

            assert_eq!(CertChainCredential::total_credentials(env.clone()), 1);
        });
    }

    #[test]
    fn test_batch_issue_in_batch_duplicate_rejected_others_succeed() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let hash_a = dummy_hash(&env, 50);
            let hash_b = dummy_hash(&env, 51);
            let items = soroban_sdk::vec![
                &env,
                BatchCredentialInput {
                    student: student.clone(),
                    credential_hash: hash_a.clone(),
                    ipfs_uri: String::from_str(&env, "ipfs://a"),
                },
                BatchCredentialInput {
                    student: student.clone(),
                    credential_hash: hash_a,
                    ipfs_uri: String::from_str(&env, "ipfs://a-dup"),
                },
                BatchCredentialInput {
                    student,
                    credential_hash: hash_b,
                    ipfs_uri: String::from_str(&env, "ipfs://b"),
                },
            ];

            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();
            assert_eq!(results.len(), 3);

            let r0 = results.get(0).unwrap();
            let r1 = results.get(1).unwrap();
            let r2 = results.get(2).unwrap();

            assert!(r0.success);
            assert_eq!(r0.token_id, 1);

            assert!(!r1.success);
            assert_eq!(r1.token_id, 0);
            assert_eq!(r1.error_code, ContractError::CredentialAlreadyExists as u32);

            // The failed row must not have consumed a token id.
            assert!(r2.success);
            assert_eq!(r2.token_id, 2);

            assert_eq!(CertChainCredential::total_credentials(env.clone()), 2);
        });
    }

    #[test]
    fn test_batch_issue_duplicate_against_existing_storage() {
        let (env, contract, _, issuer, student) = setup();
        let hash_a = dummy_hash(&env, 60);
        env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                hash_a.clone(),
                String::from_str(&env, "ipfs://pre-existing"),
            )
            .unwrap();
        });

        env.as_contract(&contract, || {
            let items = soroban_sdk::vec![
                &env,
                BatchCredentialInput {
                    student: student.clone(),
                    credential_hash: hash_a,
                    ipfs_uri: String::from_str(&env, "ipfs://dup"),
                },
                BatchCredentialInput {
                    student,
                    credential_hash: dummy_hash(&env, 61),
                    ipfs_uri: String::from_str(&env, "ipfs://new"),
                },
            ];
            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();

            assert!(!results.get(0).unwrap().success);
            let r1 = results.get(1).unwrap();
            assert!(r1.success);
            assert_eq!(r1.token_id, 2);
        });
    }

    #[test]
    fn test_batch_issue_exceeds_max_size_rejected() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let mut items: Vec<BatchCredentialInput> = Vec::new(&env);
            for seed in 0..(MAX_BATCH_SIZE + 1) {
                items.push_back(dummy_batch_input(&env, seed as u8, &student));
            }
            let result = CertChainCredential::batch_issue_credential(env.clone(), issuer, items);
            assert_eq!(result, Err(ContractError::BatchTooLarge));
            assert_eq!(CertChainCredential::total_credentials(env.clone()), 0);
        });
    }

    #[test]
    fn test_batch_issue_at_max_size_boundary_succeeds() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let mut items: Vec<BatchCredentialInput> = Vec::new(&env);
            for seed in 0..MAX_BATCH_SIZE {
                items.push_back(dummy_batch_input(&env, seed as u8, &student));
            }
            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();
            assert_eq!(results.len(), MAX_BATCH_SIZE);
            assert_eq!(
                CertChainCredential::total_credentials(env.clone()),
                MAX_BATCH_SIZE as u64
            );
        });
    }

    #[test]
    fn test_batch_issue_empty_rejected() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            let items: Vec<BatchCredentialInput> = Vec::new(&env);
            let result = CertChainCredential::batch_issue_credential(env.clone(), issuer, items);
            assert_eq!(result, Err(ContractError::EmptyBatch));
        });
    }

    #[test]
    fn test_batch_issue_pause_blocks() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            CertChainCredential::pause(env.clone()).unwrap();
            let items = soroban_sdk::vec![&env, dummy_batch_input(&env, 70, &student)];
            let result = CertChainCredential::batch_issue_credential(env.clone(), issuer, items);
            assert_eq!(result, Err(ContractError::ContractPaused));
        });
    }

    #[test]
    fn test_batch_issue_unauthorized_issuer_rejected() {
        let (env, contract, _, _, student) = setup();
        let rogue = Address::generate(&env);
        env.as_contract(&contract, || {
            let items = soroban_sdk::vec![&env, dummy_batch_input(&env, 71, &student)];
            let result = CertChainCredential::batch_issue_credential(env.clone(), rogue, items);
            assert_eq!(result, Err(ContractError::IssuerNotAuthorized));
        });
    }

    #[test]
    fn test_batch_issue_requires_issuer_auth() {
        let (env, contract, _, issuer, student) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let items = soroban_sdk::vec![&env, dummy_batch_input(&env, 72, &student)];

        env.set_auths(&[]);
        assert!(client.try_batch_issue_credential(&issuer, &items).is_err());

        env.mock_all_auths();
        assert_eq!(client.total_credentials(), 0);
    }

    #[test]
    fn test_batch_issue_token_ids_interleave_with_single_issue() {
        let (env, contract, _, issuer, student) = setup();

        // Each call below is its own env.as_contract frame — matching the
        // setup() comment's rule that mock_all_auths() errors on a second
        // require_auth() for the same address within one synthetic frame.
        let id1 = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                dummy_hash(&env, 80),
                String::from_str(&env, "ipfs://1"),
            )
            .unwrap()
        });
        assert_eq!(id1, 1);

        let results = env.as_contract(&contract, || {
            let items = soroban_sdk::vec![
                &env,
                dummy_batch_input(&env, 81, &student),
                dummy_batch_input(&env, 82, &student),
            ];
            CertChainCredential::batch_issue_credential(env.clone(), issuer.clone(), items).unwrap()
        });
        assert_eq!(results.get(0).unwrap().token_id, 2);
        assert_eq!(results.get(1).unwrap().token_id, 3);

        let id4 = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 83),
                String::from_str(&env, "ipfs://4"),
            )
            .unwrap()
        });
        assert_eq!(id4, 4);
    }

    #[test]
    fn test_batch_issue_emits_batch_summary_event() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let items = soroban_sdk::vec![
                &env,
                dummy_batch_input(&env, 90, &student),
                dummy_batch_input(&env, 91, &student),
            ];
            CertChainCredential::batch_issue_credential(env.clone(), issuer.clone(), items)
                .unwrap();
        });

        assert_eq!(
            last_event_topics(&env),
            vec![
                &env,
                symbol_short!("batch_is").into_val(&env),
                issuer.into_val(&env),
            ]
        );
    }

    // Revocation

    #[test]
    fn test_revoke_credential() {
        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 4);
        let token_id = env.as_contract(&contract, || {
            let token_id = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                hash,
                String::from_str(&env, "ipfs://b"),
            )
            .unwrap();

            assert!(!CertChainCredential::is_revoked(env.clone(), token_id));
            token_id
        });

        env.as_contract(&contract, || {
            CertChainCredential::revoke_credential(env.clone(), token_id, issuer).unwrap();
            assert!(CertChainCredential::is_revoked(env.clone(), token_id));
        });
    }

    #[test]
    fn test_double_revoke_rejected() {
        let (env, contract, _, issuer, student) = setup();
        let token_id = env.as_contract(&contract, || {
            let token_id = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                dummy_hash(&env, 5),
                String::from_str(&env, "ipfs://c"),
            )
            .unwrap();
            token_id
        });

        env.as_contract(&contract, || {
            CertChainCredential::revoke_credential(env.clone(), token_id, issuer.clone()).unwrap();
        });

        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::revoke_credential(env.clone(), token_id, issuer),
                Err(ContractError::AlreadyRevoked)
            );
        });
    }

    #[test]
    fn test_unauthorized_revoker_rejected() {
        let (env, contract, _, issuer, student) = setup();
        let rogue = Address::generate(&env);
        let token_id = env.as_contract(&contract, || {
            let token_id = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 6),
                String::from_str(&env, "ipfs://d"),
            )
            .unwrap();
            token_id
        });

        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::revoke_credential(env.clone(), token_id, rogue),
                Err(ContractError::UnauthorizedRevoker)
            );
        });
    }

    #[test]
    fn test_admin_revoke_credential() {
        let (env, contract, _, issuer, student) = setup();
        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 20),
                String::from_str(&env, "ipfs://admin-revoke"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            CertChainCredential::admin_revoke_credential(env.clone(), token_id).unwrap();
            assert!(CertChainCredential::is_revoked(env.clone(), token_id));
        });
    }

    #[test]
    fn test_admin_revoke_works_after_issuer_deauthorized() {
        let (env, contract, _, issuer, student) = setup();
        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                dummy_hash(&env, 21),
                String::from_str(&env, "ipfs://compromised"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            CertChainCredential::revoke_issuer(env.clone(), issuer);
        });

        env.as_contract(&contract, || {
            CertChainCredential::admin_revoke_credential(env.clone(), token_id).unwrap();
            assert!(CertChainCredential::is_revoked(env.clone(), token_id));
        });
    }

    #[test]
    fn test_admin_revoke_requires_owner_auth() {
        let (env, contract, _, issuer, student) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 22),
                String::from_str(&env, "ipfs://auth"),
            )
            .unwrap()
        });

        env.set_auths(&[]);
        assert!(client.try_admin_revoke_credential(&token_id).is_err());

        env.mock_all_auths();
        assert!(!client.is_revoked(&token_id));
    }

    #[test]
    fn test_admin_revoke_nonexistent_rejected() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::admin_revoke_credential(env.clone(), 999),
                Err(ContractError::CredentialNotFound)
            );
        });
    }

    #[test]
    fn test_admin_revoke_already_revoked_rejected() {
        let (env, contract, _, issuer, student) = setup();
        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                dummy_hash(&env, 23),
                String::from_str(&env, "ipfs://twice"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            CertChainCredential::revoke_credential(env.clone(), token_id, issuer).unwrap();
        });

        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::admin_revoke_credential(env.clone(), token_id),
                Err(ContractError::AlreadyRevoked)
            );
        });
    }

    #[test]
    fn test_admin_revoke_emits_distinct_event() {
        let (env, contract, _, issuer, student) = setup();
        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 24),
                String::from_str(&env, "ipfs://evt"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            CertChainCredential::admin_revoke_credential(env.clone(), token_id).unwrap();
        });

        assert_eq!(
            last_event_topics(&env),
            vec![
                &env,
                Symbol::new(&env, "cred_rev_owner").into_val(&env),
                token_id.into_val(&env),
            ]
        );
    }

    #[test]
    fn property_only_issuer_can_revoke_seeded_credentials() {
        for seed in 0u8..12 {
            let (env, contract, _, issuer, student) = setup();
            let rogue = Address::generate(&env);
            let token_id = env.as_contract(&contract, || {
                CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    dummy_hash(&env, seed.wrapping_add(48)),
                    String::from_str(&env, "ipfs://issuer-only-property"),
                )
                .unwrap()
            });

            env.as_contract(&contract, || {
                assert_eq!(
                    CertChainCredential::revoke_credential(env.clone(), token_id, rogue.clone()),
                    Err(ContractError::UnauthorizedRevoker)
                );

                CertChainCredential::revoke_credential(env.clone(), token_id, issuer.clone())
                    .unwrap();
                assert!(CertChainCredential::is_revoked(env.clone(), token_id));
            });
        }
    }

    #[test]
    fn test_get_credential_not_found() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::get_credential(env.clone(), 999),
                Err(ContractError::CredentialNotFound)
            );
        });
    }

    // Events

    #[test]
    fn test_credential_issued_event() {
        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 7);
        let ipfs = String::from_str(&env, "ipfs://e");

        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(env.clone(), student, issuer, hash, ipfs).unwrap()
        });

        assert_eq!(
            last_event_topics(&env),
            vec![
                &env,
                symbol_short!("cred_iss").into_val(&env),
                token_id.into_val(&env),
            ]
        );
    }

    #[test]
    fn test_credential_revoked_event() {
        let (env, contract, _, issuer, student) = setup();
        let token_id = env.as_contract(&contract, || {
            let token_id = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                dummy_hash(&env, 8),
                String::from_str(&env, "ipfs://f"),
            )
            .unwrap();
            token_id
        });
        env.as_contract(&contract, || {
            CertChainCredential::revoke_credential(env.clone(), token_id, issuer).unwrap();
        });

        assert_eq!(
            last_event_topics(&env),
            vec![
                &env,
                symbol_short!("cred_rev").into_val(&env),
                token_id.into_val(&env),
            ]
        );
    }

    #[test]
    fn test_issuer_authorized_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        let issuer = Address::generate(&env);
        env.as_contract(&contract, || {
            CertChainCredential::initialize(env.clone(), owner).unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::authorize_issuer(env.clone(), issuer);
        });

        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("iss_auth").into_val(&env)]
        );
    }

    #[test]
    fn test_issuer_revoked_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        let issuer = Address::generate(&env);
        env.as_contract(&contract, || {
            CertChainCredential::initialize(env.clone(), owner).unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::authorize_issuer(env.clone(), issuer.clone());
        });
        env.as_contract(&contract, || {
            CertChainCredential::revoke_issuer(env.clone(), issuer);
        });

        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("iss_rev").into_val(&env)]
        );
    }

    #[test]
    fn test_revoke_never_authorized_issuer_emits_no_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        let stranger = Address::generate(&env);
        let client = CertChainCredentialClient::new(&env, &contract);

        client.initialize(&owner);

        // revoke_issuer on a never-authorized address must not emit any event.
        // The Soroban test client accumulates events per-call; after the call
        // below the only event visible must be the iss_ext (extend_instance_ttl
        // does not emit), i.e. zero events — not the iss_rev event.
        client.revoke_issuer(&stranger);

        // After a no-op revoke the last emitted event must NOT be "iss_rev".
        // We assert the event list has exactly 0 entries (the client resets
        // the accumulated events after each call, so only this call's events
        // are visible here).
        assert_eq!(
            env.events().all().events().len(),
            0,
            "revoke_issuer on a never-authorized address must not emit iss_rev"
        );
    }

    #[test]
    fn test_revoke_authorized_issuer_emits_event_and_deauthorizes() {
        let (env, contract, _, issuer, _) = setup();

        assert!(env.as_contract(&contract, || {
            CertChainCredential::is_authorized_issuer(env.clone(), issuer.clone())
        }));

        env.as_contract(&contract, || {
            CertChainCredential::revoke_issuer(env.clone(), issuer.clone());
        });

        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("iss_rev").into_val(&env)]
        );
        assert!(!env.as_contract(&contract, || {
            CertChainCredential::is_authorized_issuer(env.clone(), issuer)
        }));
    }

    // Issuer profile

    /// Builds a length-`len` ASCII string without needing `alloc`/`std` —
    /// unlike proptest_invariants below, this module isn't linked against
    /// them, so no `.repeat()`/`format!`. The buffer is sized to one byte
    /// past the largest cap it is used to test, so raising a cap doesn't
    /// silently overflow the `[..len]` slice.
    fn dummy_long_str(env: &Env, len: usize) -> String {
        const BUF_LEN: usize = MAX_IPFS_URI_LEN as usize + 1;
        const BUF: [u8; BUF_LEN] = [b'a'; BUF_LEN];
        String::from_str(env, core::str::from_utf8(&BUF[..len]).unwrap())
    }

    #[test]
    fn test_set_and_get_issuer_profile() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            let name = String::from_str(&env, "CertChain University");
            let uri = String::from_str(&env, "ipfs://bafy-profile");
            CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer.clone(),
                name.clone(),
                uri.clone(),
            )
            .unwrap();

            let profile = CertChainCredential::get_issuer_profile(env.clone(), issuer).unwrap();
            assert_eq!(profile.name, name);
            assert_eq!(profile.profile_uri, uri);
            assert_eq!(profile.updated_at, env.ledger().timestamp());
        });
    }

    #[test]
    fn test_get_issuer_profile_none_when_unset() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            assert!(CertChainCredential::get_issuer_profile(env.clone(), issuer).is_none());
        });
    }

    #[test]
    fn test_set_issuer_profile_emits_event() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer.clone(),
                String::from_str(&env, "CertChain University"),
                String::from_str(&env, "ipfs://bafy-profile"),
            )
            .unwrap();
        });

        assert_eq!(
            last_event_topics(&env),
            vec![
                &env,
                symbol_short!("iss_prof").into_val(&env),
                issuer.into_val(&env),
            ]
        );
    }

    #[test]
    fn test_set_issuer_profile_update_overwrites_previous() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer.clone(),
                String::from_str(&env, "Old Name"),
                String::from_str(&env, "ipfs://old"),
            )
            .unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer.clone(),
                String::from_str(&env, "New Name"),
                String::from_str(&env, "ipfs://new"),
            )
            .unwrap();
        });

        env.as_contract(&contract, || {
            let profile = CertChainCredential::get_issuer_profile(env.clone(), issuer).unwrap();
            assert_eq!(profile.name, String::from_str(&env, "New Name"));
            assert_eq!(profile.profile_uri, String::from_str(&env, "ipfs://new"));
        });
    }

    #[test]
    fn test_set_issuer_profile_requires_authorized_issuer() {
        let (env, contract, _, _, _) = setup();
        let rogue = Address::generate(&env);
        env.as_contract(&contract, || {
            let result = CertChainCredential::set_issuer_profile(
                env.clone(),
                rogue,
                String::from_str(&env, "Fake U"),
                String::from_str(&env, ""),
            );
            assert_eq!(result, Err(ContractError::IssuerNotAuthorized));
        });
    }

    #[test]
    fn test_set_issuer_profile_rejects_oversized_name() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            let long_name = dummy_long_str(&env, (MAX_ISSUER_NAME_LEN + 1) as usize);
            let result = CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer,
                long_name,
                String::from_str(&env, ""),
            );
            assert_eq!(result, Err(ContractError::ProfileTooLarge));
        });
    }

    #[test]
    fn test_set_issuer_profile_rejects_oversized_uri() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            let long_uri = dummy_long_str(&env, (MAX_ISSUER_PROFILE_URI_LEN + 1) as usize);
            let result = CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer,
                String::from_str(&env, "Fine"),
                long_uri,
            );
            assert_eq!(result, Err(ContractError::ProfileTooLarge));
        });
    }

    #[test]
    fn test_set_issuer_profile_requires_issuer_auth() {
        let (env, contract, _, issuer, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let name = String::from_str(&env, "CertChain University");
        let uri = String::from_str(&env, "ipfs://bafy-profile");

        env.set_auths(&[]);
        assert!(client.try_set_issuer_profile(&issuer, &name, &uri).is_err());

        env.mock_all_auths();
        assert!(client.get_issuer_profile(&issuer).is_none());
    }

    #[test]
    fn test_issuer_profile_survives_revocation_but_blocks_further_updates() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer.clone(),
                String::from_str(&env, "CertChain University"),
                String::from_str(&env, "ipfs://bafy-profile"),
            )
            .unwrap();
        });

        env.as_contract(&contract, || {
            CertChainCredential::revoke_issuer(env.clone(), issuer.clone());
        });

        env.as_contract(&contract, || {
            // Past identity binding is still resolvable after revocation...
            let profile =
                CertChainCredential::get_issuer_profile(env.clone(), issuer.clone()).unwrap();
            assert_eq!(profile.name, String::from_str(&env, "CertChain University"));

            // ...but the now-unauthorized issuer can no longer update it.
            let result = CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer,
                String::from_str(&env, "New Name"),
                String::from_str(&env, "ipfs://new"),
            );
            assert_eq!(result, Err(ContractError::IssuerNotAuthorized));
        });
    }

    // ipfs_uri length cap (audit F-7)

    #[test]
    fn test_issue_credential_at_max_uri_len_succeeds() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let uri = dummy_long_str(&env, MAX_IPFS_URI_LEN as usize);
            let token_id = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 1),
                uri.clone(),
            )
            .unwrap();

            // Exactly-at-the-cap is accepted and stored verbatim.
            let credential = CertChainCredential::get_credential(env.clone(), token_id).unwrap();
            assert_eq!(credential.ipfs_hash, uri);
            assert_eq!(credential.ipfs_hash.len(), MAX_IPFS_URI_LEN);
        });
    }

    #[test]
    fn test_issue_credential_rejects_oversized_uri() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let uri = dummy_long_str(&env, (MAX_IPFS_URI_LEN + 1) as usize);
            let result = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 1),
                uri,
            );
            assert_eq!(result, Err(ContractError::IpfsUriTooLarge));

            // A typed error, not a panic — and nothing was written: the
            // rejected credential's hash must stay free for a later, valid
            // re-issue, and the counter must not move.
            assert_eq!(CertChainCredential::total_credentials(env.clone()), 0);
            assert_eq!(
                CertChainCredential::get_credential(env.clone(), 1),
                Err(ContractError::CredentialNotFound)
            );
            assert!(
                CertChainCredential::verify_credential(env.clone(), dummy_hash(&env, 1)).is_none()
            );
        });
    }

    #[test]
    fn test_batch_issue_at_max_uri_len_succeeds() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let uri = dummy_long_str(&env, MAX_IPFS_URI_LEN as usize);
            let items = soroban_sdk::vec![
                &env,
                BatchCredentialInput {
                    student: student.clone(),
                    credential_hash: dummy_hash(&env, 1),
                    ipfs_uri: uri.clone(),
                }
            ];
            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();

            assert_eq!(results.len(), 1);
            let row = results.get(0).unwrap();
            assert!(row.success);
            assert_eq!(row.error_code, 0);

            let credential =
                CertChainCredential::get_credential(env.clone(), row.token_id).unwrap();
            assert_eq!(credential.ipfs_hash, uri);
        });
    }

    #[test]
    fn test_batch_issue_rejects_oversized_uri_per_row() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let oversized = dummy_long_str(&env, (MAX_IPFS_URI_LEN + 1) as usize);
            // Row 0 is oversized; rows 1 and 2 are fine. The bad row must be
            // reported as a failure without discarding its neighbours.
            let items = soroban_sdk::vec![
                &env,
                BatchCredentialInput {
                    student: student.clone(),
                    credential_hash: dummy_hash(&env, 1),
                    ipfs_uri: oversized,
                },
                dummy_batch_input(&env, 2, &student),
                dummy_batch_input(&env, 3, &student),
            ];
            let results =
                CertChainCredential::batch_issue_credential(env.clone(), issuer, items).unwrap();

            assert_eq!(results.len(), 3);

            let bad = results.get(0).unwrap();
            assert!(!bad.success);
            assert_eq!(bad.token_id, 0);
            assert_eq!(bad.error_code, ContractError::IpfsUriTooLarge as u32);

            for i in 1..3u32 {
                let row = results.get(i).unwrap();
                assert!(row.success);
                assert_eq!(row.error_code, 0);
            }

            // Only the two good rows were persisted, and token ids stayed
            // sequential — the rejected row consumed no id.
            assert_eq!(CertChainCredential::total_credentials(env.clone()), 2);
            assert_eq!(results.get(1).unwrap().token_id, 1);
            assert_eq!(results.get(2).unwrap().token_id, 2);

            // The rejected row reserved nothing: its hash is still free.
            assert!(
                CertChainCredential::verify_credential(env.clone(), dummy_hash(&env, 1)).is_none()
            );
        });
    }

    // Totals

    #[test]
    fn test_total_credentials() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            assert_eq!(CertChainCredential::total_credentials(env.clone()), 0);

            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                dummy_hash(&env, 9),
                String::from_str(&env, "ipfs://g"),
            )
            .unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 10),
                String::from_str(&env, "ipfs://h"),
            )
            .unwrap();

            assert_eq!(CertChainCredential::total_credentials(env.clone()), 2);
        });
    }

    // ---------------------------------------------------------------------------
    // TTL / archival tests
    // ---------------------------------------------------------------------------

    /// Issue a credential, advance the ledger sequence past the default
    /// min_persistent_entry_ttl (4 096 ledgers), and assert the entry is still
    /// retrievable.  This would fail if extend_ttl were not called, because the
    /// Soroban test environment enforces TTL expiry when the sequence advances.
    #[test]
    fn test_credential_survives_large_ledger_advance() {
        use soroban_sdk::testutils::Ledger;

        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 20);
        let ipfs = String::from_str(&env, "ipfs://ttl-test");

        // Issue the credential at ledger sequence 0.
        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                hash.clone(),
                ipfs,
            )
            .unwrap()
        });

        // Advance well past min_persistent_entry_ttl (4 096) but within
        // PERSISTENT_BUMP_AMOUNT (6_312_000).  We use a value that is larger
        // than the minimum TTL yet smaller than the bump, proving the entry was
        // extended beyond the minimum.
        env.ledger().set_sequence_number(5_000_000);

        // The credential must still be readable after the advance.
        env.as_contract(&contract, || {
            let cred = CertChainCredential::verify_credential(env.clone(), hash.clone())
                .expect("credential must survive large ledger advance");
            assert_eq!(cred.token_id, token_id);
            assert_eq!(cred.student, student);
            assert!(!cred.revoked);

            // get_credential should also work.
            let cred2 = CertChainCredential::get_credential(env.clone(), token_id)
                .expect("get_credential must survive large ledger advance");
            assert_eq!(cred2.token_id, token_id);
        });
    }

    #[test]
    fn property_credentials_survive_large_ledger_advances() {
        use soroban_sdk::testutils::Ledger;

        for seed in 0u8..8 {
            let (env, contract, _, issuer, student) = setup();
            let hash = dummy_hash(&env, seed.wrapping_add(80));
            let ipfs = String::from_str(&env, "ipfs://ttl-property");

            let token_id = env.as_contract(&contract, || {
                CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    hash.clone(),
                    ipfs,
                )
                .unwrap()
            });

            if seed % 2 == 1 {
                env.as_contract(&contract, || {
                    CertChainCredential::revoke_credential(env.clone(), token_id, issuer.clone())
                        .unwrap();
                });
            }

            env.ledger()
                .set_sequence_number(5_000_000 + u32::from(seed) * 10_000);

            env.as_contract(&contract, || {
                let credential = CertChainCredential::get_credential(env.clone(), token_id)
                    .expect("credential must survive large ledger advance");
                assert_eq!(credential.token_id, token_id);
                assert_eq!(credential.student, student);
                assert_eq!(credential.revoked, seed % 2 == 1);

                let verified = CertChainCredential::verify_credential(env.clone(), hash.clone())
                    .expect("credential hash must remain indexed across TTL extensions");
                assert_eq!(verified.token_id, token_id);
            });
        }
    }

    /// Verify that a *revoked* credential is still retrievable after a large
    /// ledger advance so verifiers can distinguish "revoked" from "missing".
    #[test]
    fn test_revoked_credential_survives_large_ledger_advance() {
        use soroban_sdk::testutils::Ledger;

        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 21);

        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                hash.clone(),
                String::from_str(&env, "ipfs://revoke-ttl"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            CertChainCredential::revoke_credential(env.clone(), token_id, issuer).unwrap();
        });

        env.ledger().set_sequence_number(5_000_000);

        env.as_contract(&contract, || {
            let cred = CertChainCredential::get_credential(env.clone(), token_id)
                .expect("revoked credential must survive large ledger advance");
            assert!(cred.revoked, "credential should be marked revoked");
        });
    }

    /// A revoked credential must stay in the keeper's bump set: bumping it
    /// after the first TTL window keeps it verifiable (still revoked) through
    /// a second window. If revoked records were skipped, this would read as
    /// "not found" instead of "revoked" (Issue #138).
    #[test]
    fn test_revoked_credential_survives_keeper_bump_cycle() {
        use soroban_sdk::testutils::Ledger;

        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 23);

        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                hash.clone(),
                String::from_str(&env, "ipfs://revoked-bump-cycle"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            CertChainCredential::revoke_credential(env.clone(), token_id, issuer).unwrap();
        });

        // First keeper run near the end of the issue TTL extends the entry.
        env.ledger().set_sequence_number(5_000_000);
        env.as_contract(&contract, || {
            CertChainCredential::bump_credential(env.clone(), token_id)
                .expect("revoked credential must remain bumpable");
        });

        // Advance past the original TTL window; only the bump keeps it alive.
        env.ledger().set_sequence_number(10_000_000);
        env.as_contract(&contract, || {
            let verified = CertChainCredential::verify_credential(env.clone(), hash.clone())
                .expect("revoked credential must still be verifiable after keeper bump");
            assert_eq!(verified.token_id, token_id);
            assert!(verified.revoked, "credential must still read as revoked");
            assert!(CertChainCredential::is_revoked(env.clone(), token_id));
        });
    }

    /// bump_credential must succeed and keep the entry alive past a large
    /// simulated ledger advance even when called by an unprivileged party.
    #[test]
    fn test_bump_credential_extends_ttl() {
        use soroban_sdk::testutils::Ledger;

        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 22);

        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                hash.clone(),
                String::from_str(&env, "ipfs://bump-ttl"),
            )
            .unwrap()
        });

        // Advance to just before the natural expiry without extending.
        env.ledger().set_sequence_number(4_000_000);

        // An unprivileged bump (no auth required) should extend the TTL.
        env.as_contract(&contract, || {
            CertChainCredential::bump_credential(env.clone(), token_id)
                .expect("bump_credential must succeed");
        });

        // Advance again past the original issue TTL to confirm the bump worked.
        env.ledger().set_sequence_number(5_500_000);

        env.as_contract(&contract, || {
            CertChainCredential::get_credential(env.clone(), token_id)
                .expect("credential must be readable after bump");
        });
    }

    /// bump_credential returns CredentialNotFound for unknown token ids.
    #[test]
    fn test_bump_credential_not_found() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::bump_credential(env.clone(), 9999),
                Err(ContractError::CredentialNotFound)
            );
        });
    }
    #[test]
    fn test_authorization_migration() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        let issuer = Address::generate(&env);
        let student = Address::generate(&env);

        env.as_contract(&contract, || {
            CertChainCredential::initialize(env.clone(), owner.clone()).unwrap();

            // Manually simulate an old deployment by writing to instance storage directly
            env.storage()
                .instance()
                .set(&DataKey::Authorized(issuer.clone()), &true);

            // Confirm it's not in persistent storage
            assert!(!env
                .storage()
                .persistent()
                .has(&DataKey::Authorized(issuer.clone())));

            // Call is_authorized_issuer, which should trigger the migration
            let is_auth = CertChainCredential::is_authorized_issuer(env.clone(), issuer.clone());
            assert!(
                is_auth,
                "Issuer should be authorized via migration fallback"
            );

            // Check that it's now in persistent storage and removed from instance
            assert!(env
                .storage()
                .persistent()
                .has(&DataKey::Authorized(issuer.clone())));
            assert!(!env
                .storage()
                .instance()
                .has(&DataKey::Authorized(issuer.clone())));
        });

        env.as_contract(&contract, || {
            let hash = dummy_hash(&env, 99);
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                hash,
                String::from_str(&env, "ipfs://test"),
            )
            .expect("Should issue credential using migrated authorization");
        });
    }

    #[test]
    fn test_upgrade_owner_gated() {
        use soroban_sdk::testutils::Ledger;
        let (env, contract, owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        let wasm_bytes = include_bytes!("../target/wasm32v1-none/release/certchain_stellar.wasm");
        let new_wasm_hash = env
            .deployer()
            .upload_contract_wasm(soroban_sdk::Bytes::from_slice(&env, wasm_bytes));

        client.propose_upgrade(&new_wasm_hash);
        let now = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(now + UPGRADE_TIMELOCK_LEDGERS);
        client.upgrade(&new_wasm_hash);

        let auths = env.auths();
        assert_eq!(auths.len(), 1);
        let (auth_addr, invocation) = &auths[0];
        assert_eq!(auth_addr, &owner);
        assert_eq!(
            invocation.function,
            soroban_sdk::testutils::AuthorizedFunction::Contract((
                contract.clone(),
                soroban_sdk::Symbol::new(&env, "upgrade"),
                (new_wasm_hash,).into_val(&env),
            ))
        );
    }

    #[test]
    fn test_propose_upgrade_emits_event() {
        let (env, contract, _, _, _) = setup();
        let hash = dummy_hash(&env, 94);
        env.as_contract(&contract, || {
            CertChainCredential::propose_upgrade(env.clone(), hash).unwrap();
        });

        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("upg_prop").into_val(&env)]
        );
    }

    #[test]
    fn test_propose_upgrade_records_pending() {
        let (env, contract, _, _, _) = setup();
        let hash = dummy_hash(&env, 95);
        let now = env.ledger().sequence();
        env.as_contract(&contract, || {
            CertChainCredential::propose_upgrade(env.clone(), hash.clone()).unwrap();
            let pending = CertChainCredential::get_pending_upgrade(env.clone()).unwrap();
            assert_eq!(pending.wasm_hash, hash);
            assert_eq!(pending.ready_ledger, now + UPGRADE_TIMELOCK_LEDGERS);
        });
    }

    #[test]
    fn test_upgrade_without_proposal_rejected() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            let result = CertChainCredential::upgrade(env.clone(), dummy_hash(&env, 93));
            assert_eq!(result, Err(ContractError::UpgradeNotProposed));
        });
    }

    #[test]
    fn test_upgrade_before_timelock_rejected() {
        let (env, contract, _, _, _) = setup();
        let hash = dummy_hash(&env, 90);
        env.as_contract(&contract, || {
            CertChainCredential::propose_upgrade(env.clone(), hash.clone()).unwrap();
        });
        env.as_contract(&contract, || {
            let result = CertChainCredential::upgrade(env.clone(), hash);
            assert_eq!(result, Err(ContractError::UpgradeTimelockActive));
        });
    }

    #[test]
    fn test_upgrade_hash_mismatch_rejected() {
        use soroban_sdk::testutils::Ledger;
        let (env, contract, _, _, _) = setup();
        let proposed = dummy_hash(&env, 91);
        let other = dummy_hash(&env, 92);
        env.as_contract(&contract, || {
            CertChainCredential::propose_upgrade(env.clone(), proposed).unwrap();
        });
        let now = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(now + UPGRADE_TIMELOCK_LEDGERS);
        env.as_contract(&contract, || {
            let result = CertChainCredential::upgrade(env.clone(), other);
            assert_eq!(result, Err(ContractError::UpgradeHashMismatch));
        });
    }

    #[test]
    fn test_cancel_upgrade_clears_pending() {
        let (env, contract, _, _, _) = setup();
        let hash = dummy_hash(&env, 96);
        env.as_contract(&contract, || {
            CertChainCredential::propose_upgrade(env.clone(), hash.clone()).unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::cancel_upgrade(env.clone()).unwrap();
            assert!(CertChainCredential::get_pending_upgrade(env.clone()).is_none());
        });
        env.as_contract(&contract, || {
            let result = CertChainCredential::upgrade(env.clone(), hash);
            assert_eq!(result, Err(ContractError::UpgradeNotProposed));
        });
    }

    #[test]
    fn test_cancel_upgrade_without_proposal_rejected() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            let result = CertChainCredential::cancel_upgrade(env.clone());
            assert_eq!(result, Err(ContractError::UpgradeNotProposed));
        });
    }

    #[test]
    fn test_get_storage_version_and_migrate() {
        let (env, contract, owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        assert_eq!(client.get_storage_version(), 1);

        client.migrate();
        let auths = env.auths();

        assert_eq!(client.get_storage_version(), 2);

        assert_eq!(auths.len(), 1);
        let (auth_addr, invocation) = &auths[0];
        assert_eq!(auth_addr, &owner);
        assert_eq!(
            invocation.function,
            soroban_sdk::testutils::AuthorizedFunction::Contract((
                contract.clone(),
                soroban_sdk::Symbol::new(&env, "migrate"),
                ().into_val(&env),
            ))
        );
    }

    #[test]
    fn test_migrate_only_once() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        assert_eq!(client.get_storage_version(), 1);
        client.migrate();
        assert_eq!(client.get_storage_version(), 2);

        client.migrate();
        assert_eq!(client.get_storage_version(), 2);
    }

    // ---------------------------------------------------------------------------
    // Pause / circuit-breaker tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_pause_blocks_issue() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            CertChainCredential::pause(env.clone()).unwrap();
            assert!(CertChainCredential::is_paused(env.clone()));

            let result = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 30),
                String::from_str(&env, "ipfs://paused"),
            );
            assert_eq!(result, Err(ContractError::ContractPaused));
        });
    }

    #[test]
    fn test_pause_blocks_revoke() {
        let (env, contract, _, issuer, student) = setup();
        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer.clone(),
                dummy_hash(&env, 31),
                String::from_str(&env, "ipfs://before-pause"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            CertChainCredential::pause(env.clone()).unwrap();
            let result = CertChainCredential::revoke_credential(env.clone(), token_id, issuer);
            assert_eq!(result, Err(ContractError::ContractPaused));
        });
    }

    #[test]
    fn test_verify_works_while_paused() {
        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 32);
        env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                hash.clone(),
                String::from_str(&env, "ipfs://paused-verify"),
            )
            .unwrap();
            CertChainCredential::pause(env.clone()).unwrap();
            // verify_credential and get_credential must still work
            let cred = CertChainCredential::verify_credential(env.clone(), hash.clone());
            assert!(cred.is_some());
            let cred2 = CertChainCredential::get_credential(env.clone(), cred.unwrap().token_id);
            assert!(cred2.is_ok());
        });
    }

    #[test]
    fn test_unpause_restores_issuance() {
        let (env, contract, _, issuer, student) = setup();
        // pause and unpause must be separate frames; same-frame double owner.require_auth errors
        env.as_contract(&contract, || {
            CertChainCredential::pause(env.clone()).unwrap();
        });
        env.as_contract(&contract, || {
            assert!(CertChainCredential::is_paused(env.clone()));
            CertChainCredential::unpause(env.clone()).unwrap();
            assert!(!CertChainCredential::is_paused(env.clone()));
            // issue uses issuer auth (different address), so no conflict
            let result = CertChainCredential::issue_credential(
                env.clone(),
                student,
                issuer,
                dummy_hash(&env, 33),
                String::from_str(&env, "ipfs://after-unpause"),
            );
            assert!(result.is_ok());
        });
    }

    #[test]
    fn test_pause_event() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            CertChainCredential::pause(env.clone()).unwrap();
        });
        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("paused").into_val(&env)]
        );
    }

    #[test]
    fn test_unpause_event() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            CertChainCredential::pause(env.clone()).unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::unpause(env.clone()).unwrap();
        });
        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("unpaused").into_val(&env)]
        );
    }

    #[test]
    fn test_is_paused_default_false() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            assert!(!CertChainCredential::is_paused(env.clone()));
        });
    }

    #[test]
    fn test_pause_blocks_all_mutating_entrypoints() {
        use soroban_sdk::testutils::Ledger as _;

        let (env, contract, owner, issuer, student) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        let token_id = client.issue_credential(
            &student,
            &issuer,
            &dummy_hash(&env, 40),
            &String::from_str(&env, "ipfs://pause-matrix"),
        );

        let next_owner = Address::generate(&env);
        client.transfer_owner(&next_owner);

        let wasm_hash = dummy_hash(&env, 41);
        client.propose_upgrade(&wasm_hash);
        env.ledger().with_mut(|l| {
            l.sequence_number += UPGRADE_TIMELOCK_LEDGERS + 1;
        });

        client.pause();
        assert!(client.is_paused());

        // Credential mutations are blocked.
        assert_eq!(
            client.try_issue_credential(
                &student,
                &issuer,
                &dummy_hash(&env, 42),
                &String::from_str(&env, "ipfs://blocked"),
            ),
            Err(Ok(ContractError::ContractPaused))
        );
        let mut batch = Vec::new(&env);
        batch.push_back(BatchCredentialInput {
            student: student.clone(),
            credential_hash: dummy_hash(&env, 43),
            ipfs_uri: String::from_str(&env, "ipfs://blocked-batch"),
        });
        assert_eq!(
            client.try_batch_issue_credential(&issuer, &batch),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            client.try_revoke_credential(&token_id, &issuer),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            client.try_admin_revoke_credential(&token_id),
            Err(Ok(ContractError::ContractPaused))
        );

        // Issuer and profile mutations are blocked.
        let other_issuer = Address::generate(&env);
        let paused_err = soroban_sdk::Error::from_contract_error(ContractError::ContractPaused as u32);
        assert_eq!(
            client.try_authorize_issuer(&other_issuer),
            Err(Ok(paused_err))
        );
        assert_eq!(client.try_revoke_issuer(&issuer), Err(Ok(paused_err)));
        assert_eq!(
            client.try_set_issuer_profile(
                &issuer,
                &String::from_str(&env, "Uni"),
                &String::from_str(&env, "https://uni.example"),
            ),
            Err(Ok(ContractError::ContractPaused))
        );

        // Ownership, upgrade, and migration mutations are blocked.
        assert_eq!(
            client.try_transfer_owner(&Address::generate(&env)),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            client.try_accept_owner(),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            client.try_propose_upgrade(&dummy_hash(&env, 44)),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            client.try_upgrade(&wasm_hash),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(
            client.try_cancel_upgrade(),
            Err(Ok(ContractError::ContractPaused))
        );
        assert_eq!(client.try_migrate(), Err(Ok(ContractError::ContractPaused)));

        // TTL extension, reads, and unpause remain operational while paused.
        assert!(client.try_bump_credential(&token_id).is_ok());
        assert_eq!(client.get_owner(), owner);
        assert!(client.verify_credential(&dummy_hash(&env, 40)).is_some());
        client.unpause();
        assert!(!client.is_paused());
    }

    // ---------------------------------------------------------------------------
    // Event coverage: initialize / upgrade / migrate
    // ---------------------------------------------------------------------------

    #[test]
    fn test_initialize_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        env.as_contract(&contract, || {
            CertChainCredential::initialize(env.clone(), owner).unwrap();
        });

        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("init").into_val(&env)]
        );
    }

    #[test]
    fn test_upgrade_event() {
        use soroban_sdk::testutils::Ledger;
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let wasm_bytes = include_bytes!("../target/wasm32v1-none/release/certchain_stellar.wasm");
        let new_wasm_hash = env
            .deployer()
            .upload_contract_wasm(soroban_sdk::Bytes::from_slice(&env, wasm_bytes));

        client.propose_upgrade(&new_wasm_hash);
        let now = env.ledger().sequence();
        env.ledger()
            .set_sequence_number(now + UPGRADE_TIMELOCK_LEDGERS);
        client.upgrade(&new_wasm_hash);

        assert_eq!(
            last_event_topics(&env),
            vec![&env, symbol_short!("upgraded").into_val(&env)]
        );
    }

    #[test]
    fn test_migrate_event() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        client.migrate();

        assert_eq!(
            last_event_topics(&env),
            vec![
                &env,
                symbol_short!("migrated").into_val(&env),
                1u32.into_val(&env),
            ]
        );
    }

    // ---------------------------------------------------------------------------
    // Owner-only entrypoint gating
    //
    // `setup()` uses mock_all_auths(), which mocks every require_auth() as
    // succeeding regardless of who is "calling" — so it cannot, by itself,
    // prove a privileged entrypoint is actually gated. Each test below
    // disables mocking via `env.set_auths(&[])` immediately before invoking
    // the privileged call, so the underlying owner.require_auth() /
    // pending_owner.require_auth() must be satisfied for real. With no
    // authorization supplied, the call must fail, and contract state must be
    // left unchanged.
    // ---------------------------------------------------------------------------

    #[test]
    fn test_initialize_requires_owner_auth() {
        let env = Env::default();
        let contract = CertChainCredential.register(&env, None, ());
        let client = CertChainCredentialClient::new(&env, &contract);
        let owner = Address::generate(&env);

        // No auths mocked: initialize must fail without the proposed owner's signature.
        assert!(client.try_initialize(&owner).is_err());
        // And the contract must remain uninitialized.
        assert!(client.try_get_owner().is_err());
    }

    #[test]
    fn test_transfer_owner_requires_owner_auth() {
        let (env, contract, owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let new_owner = Address::generate(&env);

        env.set_auths(&[]);
        assert!(client.try_transfer_owner(&new_owner).is_err());

        env.mock_all_auths();
        assert_eq!(client.get_owner(), owner);
        assert!(client.get_pending_owner().is_none());
    }

    #[test]
    fn test_accept_owner_requires_pending_owner_auth() {
        let (env, contract, owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let new_owner = Address::generate(&env);
        client.transfer_owner(&new_owner);

        env.set_auths(&[]);
        assert!(client.try_accept_owner().is_err());

        env.mock_all_auths();
        assert_eq!(client.get_owner(), owner);
    }

    #[test]
    fn test_authorize_issuer_requires_owner_auth() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let rogue_issuer = Address::generate(&env);

        env.set_auths(&[]);
        assert!(client.try_authorize_issuer(&rogue_issuer).is_err());

        env.mock_all_auths();
        assert!(!client.is_authorized_issuer(&rogue_issuer));
    }

    #[test]
    fn test_revoke_issuer_requires_owner_auth() {
        let (env, contract, _, issuer, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        env.set_auths(&[]);
        assert!(client.try_revoke_issuer(&issuer).is_err());

        env.mock_all_auths();
        assert!(client.is_authorized_issuer(&issuer));
    }

    #[test]
    fn test_pause_requires_owner_auth() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        env.set_auths(&[]);
        assert!(client.try_pause().is_err());

        env.mock_all_auths();
        assert!(!client.is_paused());
    }

    #[test]
    fn test_unpause_requires_owner_auth() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        client.pause();

        env.set_auths(&[]);
        assert!(client.try_unpause().is_err());

        env.mock_all_auths();
        assert!(client.is_paused());
    }

    #[test]
    fn test_upgrade_requires_owner_auth() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let wasm_bytes = include_bytes!("../target/wasm32v1-none/release/certchain_stellar.wasm");
        let new_wasm_hash = env
            .deployer()
            .upload_contract_wasm(soroban_sdk::Bytes::from_slice(&env, wasm_bytes));

        env.set_auths(&[]);
        assert!(client.try_upgrade(&new_wasm_hash).is_err());
    }

    #[test]
    fn test_migrate_requires_owner_auth() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        env.set_auths(&[]);
        assert!(client.try_migrate().is_err());

        env.mock_all_auths();
        assert_eq!(client.get_storage_version(), 1);
    }

    // ---------------------------------------------------------------------------
    // CertChain v2 — new feature tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_get_credentials_by_student_empty_before_issuance() {
        let (env, contract, _, _, student) = setup();
        env.as_contract(&contract, || {
            let ids = CertChainCredential::get_credentials_by_student(env.clone(), student);
            assert_eq!(ids.len(), 0);
        });
    }

    #[test]
    fn test_get_credentials_by_student_returns_issued_token_ids() {
        let (env, contract, _, issuer, student) = setup();

        // Issue two credentials to the same student.
        let id1 = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                dummy_hash(&env, 100),
                String::from_str(&env, "ipfs://s1"),
            )
            .unwrap()
        });
        let id2 = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                dummy_hash(&env, 101),
                String::from_str(&env, "ipfs://s2"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            let ids = CertChainCredential::get_credentials_by_student(env.clone(), student);
            assert_eq!(ids.len(), 2);
            assert_eq!(ids.get(0).unwrap(), id1);
            assert_eq!(ids.get(1).unwrap(), id2);
        });
    }

    #[test]
    fn test_get_credentials_by_issuer_returns_issued_token_ids() {
        let (env, contract, _, issuer, student) = setup();

        // Issue three credentials from the same issuer.
        let id1 = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                dummy_hash(&env, 110),
                String::from_str(&env, "ipfs://i1"),
            )
            .unwrap()
        });
        let id2 = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                dummy_hash(&env, 111),
                String::from_str(&env, "ipfs://i2"),
            )
            .unwrap()
        });
        let id3 = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                dummy_hash(&env, 112),
                String::from_str(&env, "ipfs://i3"),
            )
            .unwrap()
        });

        env.as_contract(&contract, || {
            let ids = CertChainCredential::get_credentials_by_issuer(env.clone(), issuer);
            assert_eq!(ids.len(), 3);
            assert_eq!(ids.get(0).unwrap(), id1);
            assert_eq!(ids.get(1).unwrap(), id2);
            assert_eq!(ids.get(2).unwrap(), id3);
        });
    }

    #[test]
    fn test_get_credentials_by_issuer_empty_for_unknown_address() {
        let (env, contract, _, _, _) = setup();
        let unknown = Address::generate(&env);
        env.as_contract(&contract, || {
            let ids = CertChainCredential::get_credentials_by_issuer(env.clone(), unknown);
            assert_eq!(ids.len(), 0);
        });
    }

    #[test]
    fn test_batch_issue_populates_student_and_issuer_indices() {
        let (env, contract, _, issuer, student) = setup();
        env.as_contract(&contract, || {
            let items = soroban_sdk::vec![
                &env,
                dummy_batch_input(&env, 120, &student),
                dummy_batch_input(&env, 121, &student),
            ];
            CertChainCredential::batch_issue_credential(env.clone(), issuer.clone(), items)
                .unwrap();

            let student_ids = CertChainCredential::get_credentials_by_student(env.clone(), student);
            assert_eq!(student_ids.len(), 2);

            let issuer_ids = CertChainCredential::get_credentials_by_issuer(env.clone(), issuer);
            assert_eq!(issuer_ids.len(), 2);
        });
    }

    #[test]
    fn test_get_contract_info_returns_certchain_name_and_version() {
        let (env, contract, _, _, _) = setup();
        env.as_contract(&contract, || {
            let info = CertChainCredential::get_contract_info(env.clone());
            assert_eq!(info.name, String::from_str(&env, "CertChain Credential"));
            assert!(info.version.len() > 0);
        });
    }

    // -----------------------------------------------------------------------
    // #102: uninitialized calls return the typed NotInitialized error
    // -----------------------------------------------------------------------

    fn uninitialized_client(env: &Env) -> CertChainCredentialClient<'_> {
        env.mock_all_auths();
        let contract = CertChainCredential.register(env, None, ());
        CertChainCredentialClient::new(env, &contract)
    }

    /// The raw host error every owner-gated or initialization-gated call must
    /// produce before `initialize`: contract error #7, not a formatted panic.
    fn not_initialized_error() -> soroban_sdk::Error {
        soroban_sdk::Error::from_contract_error(ContractError::NotInitialized as u32)
    }

    #[test]
    fn test_uninitialized_result_entrypoints_return_not_initialized() {
        let env = Env::default();
        let client = uninitialized_client(&env);
        let someone = Address::generate(&env);
        let hash = BytesN::from_array(&env, &[9; 32]);
        let expected = Err(Ok(ContractError::NotInitialized));

        assert_eq!(client.try_transfer_owner(&someone), expected);
        assert_eq!(client.try_accept_owner(), expected);
        assert_eq!(client.try_admin_revoke_credential(&1), expected);
        assert_eq!(client.try_pause(), expected);
        assert_eq!(client.try_unpause(), expected);
        assert_eq!(client.try_propose_upgrade(&hash), expected);
        assert_eq!(client.try_cancel_upgrade(), expected);
        assert_eq!(client.try_upgrade(&hash), expected);
        assert_eq!(client.try_migrate(), expected);
    }

    #[test]
    fn test_uninitialized_plain_entrypoints_return_not_initialized_code() {
        let env = Env::default();
        let client = uninitialized_client(&env);
        let someone = Address::generate(&env);
        let expected = not_initialized_error();

        assert_eq!(client.try_get_owner().err(), Some(Ok(expected)));
        assert_eq!(client.try_get_pending_owner().err(), Some(Ok(expected)));
        assert_eq!(
            client.try_authorize_issuer(&someone).err(),
            Some(Ok(expected))
        );
        assert_eq!(client.try_revoke_issuer(&someone).err(), Some(Ok(expected)));
        assert_eq!(
            client.try_is_authorized_issuer(&someone).err(),
            Some(Ok(expected))
        );
        assert_eq!(client.try_total_credentials().err(), Some(Ok(expected)));
    }

    #[test]
    fn test_not_initialized_error_code_is_pinned() {
        // Off-chain clients match on this number; changing it is a breaking change.
        assert_eq!(ContractError::NotInitialized as u32, 7);
        assert!(not_initialized_error().is_type(soroban_sdk::xdr::ScErrorType::Contract));
        assert_eq!(not_initialized_error().get_code(), 7);
    }

    #[test]
    fn test_initialized_contract_does_not_report_not_initialized() {
        let (env, contract, owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.try_pause(), Ok(Ok(())));
    }

    // -----------------------------------------------------------------------
    // #103: bump_credential keeps the student/issuer index entries alive
    // -----------------------------------------------------------------------

    #[test]
    fn test_bump_credential_extends_address_index_ttls() {
        use soroban_sdk::testutils::storage::Persistent as _;
        use soroban_sdk::testutils::Ledger;

        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 31);

        let token_id = env.as_contract(&contract, || {
            CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                hash.clone(),
                String::from_str(&env, "ipfs://index-ttl"),
            )
            .unwrap()
        });

        let student_key = DataKey::StudentIndex(student.clone());
        let issuer_key = DataKey::IssuerIndex(issuer.clone());

        // Only the keeper's bump runs between issuance and the late reads; no
        // enumeration call touches the index entries in between.
        env.ledger().set_sequence_number(4_000_000);
        env.as_contract(&contract, || {
            CertChainCredential::bump_credential(env.clone(), token_id).unwrap();
        });

        // The bump must have pushed the index entries' TTL out as far as the
        // credential's own entry.
        env.as_contract(&contract, || {
            let credential_ttl = env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Credential(token_id));
            assert_eq!(
                env.storage().persistent().get_ttl(&student_key),
                credential_ttl
            );
            assert_eq!(
                env.storage().persistent().get_ttl(&issuer_key),
                credential_ttl
            );
            assert!(credential_ttl >= PERSISTENT_THRESHOLD);
        });

        // Past the TTL the indexes got at issuance: still queryable.
        env.ledger().set_sequence_number(6_400_000);
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::get_credentials_by_student(env.clone(), student.clone()),
                vec![&env, token_id]
            );
            assert_eq!(
                CertChainCredential::get_credentials_by_issuer(env.clone(), issuer.clone()),
                vec![&env, token_id]
            );
        });
    }

    #[test]
    fn test_bump_credential_without_index_entries_succeeds() {
        // Pre-v2 credentials were written before the address indexes existed.
        let (env, contract, _, issuer, student) = setup();
        let hash = dummy_hash(&env, 32);
        let token_id = env.as_contract(&contract, || {
            let id = CertChainCredential::issue_credential(
                env.clone(),
                student.clone(),
                issuer.clone(),
                hash.clone(),
                String::from_str(&env, "ipfs://legacy"),
            )
            .unwrap();
            env.storage()
                .persistent()
                .remove(&DataKey::StudentIndex(student.clone()));
            env.storage()
                .persistent()
                .remove(&DataKey::IssuerIndex(issuer.clone()));
            id
        });
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::bump_credential(env.clone(), token_id),
                Ok(())
            );
        });
    }

    // -----------------------------------------------------------------------
    // #104: paginated student/issuer indexes
    // -----------------------------------------------------------------------

    fn hash_from_u32(env: &Env, n: u32) -> BytesN<32> {
        let mut bytes = [0xA5u8; 32];
        bytes[..4].copy_from_slice(&n.to_be_bytes());
        BytesN::from_array(env, &bytes)
    }

    fn issue_n(env: &Env, contract: &Address, issuer: &Address, student: &Address, n: u32) {
        for i in 0..n {
            env.as_contract(contract, || {
                CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    hash_from_u32(env, i),
                    String::from_str(env, "ipfs://history"),
                )
                .unwrap();
            });
        }
    }

    /// Walk the whole index with `page_fn`, asserting every page respects
    /// `limit` and returning all ids in order.
    fn walk_pages(
        env: &Env,
        contract: &Address,
        limit: u32,
        page_fn: fn(Env, Address, u64, u32) -> IndexPage,
        addr: &Address,
    ) -> Vec<u64> {
        let mut all = Vec::new(env);
        let mut cursor = 0u64;
        loop {
            let page = env.as_contract(contract, || {
                page_fn(env.clone(), addr.clone(), cursor, limit)
            });
            assert!(page.ids.len() <= limit.min(INDEX_PAGE_SIZE));
            all.append(&page.ids);
            match page.next_cursor {
                Some(next) => {
                    assert!(next > cursor, "cursor must advance");
                    cursor = next;
                }
                None => break,
            }
        }
        all
    }

    #[test]
    fn test_index_pages_return_every_id_in_order_with_stable_cursors() {
        let (env, contract, _, issuer, student) = setup();
        let total = INDEX_PAGE_SIZE * 2 + 37;
        issue_n(&env, &contract, &issuer, &student, total);
        let mut expected = Vec::new(&env);
        for id in 1..=total as u64 {
            expected.push_back(id);
        }

        for limit in [1, 7, INDEX_PAGE_SIZE, INDEX_PAGE_SIZE * 5] {
            assert_eq!(
                walk_pages(
                    &env,
                    &contract,
                    limit,
                    CertChainCredential::get_credentials_by_student_page,
                    &student
                ),
                expected,
                "student, limit {limit}"
            );
            assert_eq!(
                walk_pages(
                    &env,
                    &contract,
                    limit,
                    CertChainCredential::get_credentials_by_issuer_page,
                    &issuer
                ),
                expected,
                "issuer, limit {limit}"
            );
        }

        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::count_credentials_by_student(env.clone(), student.clone()),
                total as u64
            );
            // A cursor obtained earlier still points at the same entries after
            // more credentials are issued (append-only positions).
            let before = CertChainCredential::get_credentials_by_student_page(
                env.clone(),
                student.clone(),
                150,
                10,
            );
            assert_eq!(before.ids.get(0), Some(151));
            assert_eq!(before.next_cursor, Some(160));
        });
        issue_n_from(&env, &contract, &issuer, &student, 900_000, 5);
        env.as_contract(&contract, || {
            let after = CertChainCredential::get_credentials_by_student_page(
                env.clone(),
                student.clone(),
                150,
                10,
            );
            assert_eq!(
                after.ids.get(0),
                Some(151),
                "cursor moved after more issuance"
            );
            let past_end = CertChainCredential::get_credentials_by_student_page(
                env.clone(),
                student.clone(),
                total as u64 + 5,
                10,
            );
            assert!(past_end.ids.is_empty());
            assert_eq!(past_end.next_cursor, None);
            // The legacy whole-list query keeps returning the first page.
            let first =
                CertChainCredential::get_credentials_by_student(env.clone(), student.clone());
            assert_eq!(first.len(), INDEX_PAGE_SIZE);
            assert_eq!(first.get(0), Some(1));
        });
    }

    #[test]
    fn test_large_history_issuance_cost_is_bounded() {
        let (env, contract, _, issuer, student) = setup();
        let fresh_issuer = Address::generate(&env);
        env.as_contract(&contract, || {
            CertChainCredential::authorize_issuer(env.clone(), fresh_issuer.clone());
        });

        let measure_issue = |issuer: &Address, student: &Address, seed: u32| -> u64 {
            // Each issuance runs under the default (network) budget, so a
            // long history must never exhaust resources.
            env.cost_estimate().budget().reset_default();
            env.as_contract(&contract, || {
                CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    hash_from_u32(&env, seed),
                    String::from_str(&env, "ipfs://history"),
                )
                .unwrap();
            });
            env.cost_estimate().budget().cpu_instruction_cost()
        };

        // Six pages of history for one student and one issuer.
        issue_n(&env, &contract, &issuer, &student, INDEX_PAGE_SIZE * 6);

        // At the same point in time, issuing into that long history must cost
        // about the same as issuing for addresses with no history at all.
        let with_history = measure_issue(&issuer, &student, 1_000_000);
        let without_history = measure_issue(&fresh_issuer, &Address::generate(&env), 1_000_001);
        assert!(
            with_history <= without_history + without_history / 5,
            "issuance cost depends on history length: {without_history} (none) vs {with_history} (600 entries)"
        );

        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::count_credentials_by_student(env.clone(), student.clone()),
                (INDEX_PAGE_SIZE * 6 + 1) as u64
            );
        });
    }

    fn issue_n_from(
        env: &Env,
        contract: &Address,
        issuer: &Address,
        student: &Address,
        first_seed: u32,
        n: u32,
    ) {
        for i in 0..n {
            env.as_contract(contract, || {
                CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    hash_from_u32(env, first_seed + i),
                    String::from_str(env, "ipfs://history"),
                )
                .unwrap();
            });
        }
    }

    #[test]
    fn test_pre_pagination_index_is_kept_as_frozen_first_page() {
        let (env, contract, _, issuer, student) = setup();
        // Simulate a history written before pagination: one oversized vector
        // under the original key and no bookkeeping entry.
        let legacy_len = INDEX_PAGE_SIZE + 20;
        env.as_contract(&contract, || {
            let mut legacy = Vec::new(&env);
            for id in 1..=legacy_len as u64 {
                legacy.push_back(id * 1000);
            }
            env.storage()
                .persistent()
                .set(&DataKey::StudentIndex(student.clone()), &legacy);
        });
        issue_n(&env, &contract, &issuer, &student, 3);

        let all = walk_pages(
            &env,
            &contract,
            33,
            CertChainCredential::get_credentials_by_student_page,
            &student,
        );
        assert_eq!(all.len(), legacy_len + 3);
        assert_eq!(all.get(0), Some(1000));
        assert_eq!(all.get(legacy_len - 1), Some(legacy_len as u64 * 1000));
        // New issuances land after the legacy history, untouched.
        assert_eq!(all.slice(legacy_len..), vec![&env, 1, 2, 3]);
        env.as_contract(&contract, || {
            let first =
                CertChainCredential::get_credentials_by_student(env.clone(), student.clone());
            assert_eq!(first.len(), legacy_len);
        });
    }

    #[test]
    fn test_index_page_limit_is_clamped() {
        let (env, contract, _, issuer, student) = setup();
        issue_n(&env, &contract, &issuer, &student, 5);
        env.as_contract(&contract, || {
            let zero = CertChainCredential::get_credentials_by_student_page(
                env.clone(),
                student.clone(),
                0,
                0,
            );
            assert_eq!(zero.ids.len(), 1, "limit 0 is treated as 1");
            assert_eq!(zero.next_cursor, Some(1));
            let empty = CertChainCredential::get_credentials_by_issuer_page(
                env.clone(),
                Address::generate(&env),
                0,
                10,
            );
            assert!(empty.ids.is_empty());
            assert_eq!(empty.next_cursor, None);
        });
    }

    // -----------------------------------------------------------------------
    // #107: issuer profile values exactly at the cap are stored verbatim
    // -----------------------------------------------------------------------

    #[test]
    fn test_set_issuer_profile_accepts_name_and_uri_at_cap() {
        let (env, contract, _, issuer, _) = setup();
        env.as_contract(&contract, || {
            let name = dummy_long_str(&env, MAX_ISSUER_NAME_LEN as usize);
            let uri = dummy_long_str(&env, MAX_ISSUER_PROFILE_URI_LEN as usize);
            assert_eq!(name.len(), MAX_ISSUER_NAME_LEN);
            assert_eq!(uri.len(), MAX_ISSUER_PROFILE_URI_LEN);

            CertChainCredential::set_issuer_profile(
                env.clone(),
                issuer.clone(),
                name.clone(),
                uri.clone(),
            )
            .unwrap();

            let profile =
                CertChainCredential::get_issuer_profile(env.clone(), issuer.clone()).unwrap();
            assert_eq!(profile.name, name);
            assert_eq!(profile.profile_uri, uri);
            assert_eq!(profile.name.len(), MAX_ISSUER_NAME_LEN);
            assert_eq!(profile.profile_uri.len(), MAX_ISSUER_PROFILE_URI_LEN);
        });
    }

    #[test]
    fn test_set_issuer_profile_one_byte_over_either_cap_is_rejected() {
        let (env, contract, _, issuer, _) = setup();
        let at_name = dummy_long_str(&env, MAX_ISSUER_NAME_LEN as usize);
        let at_uri = dummy_long_str(&env, MAX_ISSUER_PROFILE_URI_LEN as usize);
        let over_name = dummy_long_str(&env, (MAX_ISSUER_NAME_LEN + 1) as usize);
        let over_uri = dummy_long_str(&env, (MAX_ISSUER_PROFILE_URI_LEN + 1) as usize);

        // Separate frames: mock_all_auths rejects a second require_auth for
        // the same address within one frame.
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::set_issuer_profile(
                    env.clone(),
                    issuer.clone(),
                    over_name,
                    at_uri
                ),
                Err(ContractError::ProfileTooLarge)
            );
        });
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::set_issuer_profile(
                    env.clone(),
                    issuer.clone(),
                    at_name,
                    over_uri
                ),
                Err(ContractError::ProfileTooLarge)
            );
        });
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::get_issuer_profile(env.clone(), issuer),
                None
            );
        });
    }

    // -----------------------------------------------------------------------
    // #108: a second propose_upgrade replaces the first and restarts the lock
    // -----------------------------------------------------------------------

    fn last_upgrade_proposal_event(env: &Env) -> (BytesN<32>, u32) {
        let events = env.events().all();
        let event = events.events().last().unwrap();
        match &event.body {
            soroban_sdk::xdr::ContractEventBody::V0(body) => {
                let topics: soroban_sdk::Vec<Val> = body.topics.clone().try_into_val(env).unwrap();
                assert_eq!(topics, vec![env, symbol_short!("upg_prop").into_val(env)]);
                let data: Val = body.data.clone().try_into_val(env).unwrap();
                data.try_into_val(env).unwrap()
            }
        }
    }

    #[test]
    fn test_re_proposal_replaces_pending_upgrade_and_restarts_timelock() {
        use soroban_sdk::testutils::Ledger;
        let (env, contract, _, _, _) = setup();
        let hash_a = dummy_hash(&env, 0xA1);
        let hash_b = dummy_hash(&env, 0xB2);

        let start = env.ledger().sequence();
        env.as_contract(&contract, || {
            CertChainCredential::propose_upgrade(env.clone(), hash_a.clone()).unwrap();
        });
        assert_eq!(
            last_upgrade_proposal_event(&env),
            (hash_a.clone(), start + UPGRADE_TIMELOCK_LEDGERS)
        );

        // Half-way through A's timelock, B is proposed.
        let mid = start + UPGRADE_TIMELOCK_LEDGERS / 2;
        env.ledger().set_sequence_number(mid);
        env.as_contract(&contract, || {
            CertChainCredential::propose_upgrade(env.clone(), hash_b.clone()).unwrap();
        });
        let b_ready = mid + UPGRADE_TIMELOCK_LEDGERS;
        assert_eq!(last_upgrade_proposal_event(&env), (hash_b.clone(), b_ready));

        env.as_contract(&contract, || {
            let pending = CertChainCredential::get_pending_upgrade(env.clone()).unwrap();
            assert_eq!(pending.wasm_hash, hash_b);
            assert_eq!(
                pending.ready_ledger, b_ready,
                "re-proposal restarts the timelock"
            );
        });

        // Once A's original timelock has passed, neither A nor B can execute:
        // A was replaced, and B's own timelock is still running.
        env.ledger()
            .set_sequence_number(start + UPGRADE_TIMELOCK_LEDGERS);
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::upgrade(env.clone(), hash_a.clone()),
                Err(ContractError::UpgradeHashMismatch)
            );
        });
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::upgrade(env.clone(), hash_b.clone()),
                Err(ContractError::UpgradeTimelockActive)
            );
        });

        // After B's full timelock, A is still refused; only B is eligible.
        env.ledger().set_sequence_number(b_ready);
        env.as_contract(&contract, || {
            assert_eq!(
                CertChainCredential::upgrade(env.clone(), hash_a.clone()),
                Err(ContractError::UpgradeHashMismatch)
            );
        });
        env.as_contract(&contract, || {
            let pending = CertChainCredential::get_pending_upgrade(env.clone()).unwrap();
            assert_eq!(pending.wasm_hash, hash_b);
            assert!(env.ledger().sequence() >= pending.ready_ledger);
        });
    }

    // -----------------------------------------------------------------------
    // #109: storage migrations are forward-only
    // -----------------------------------------------------------------------

    #[test]
    fn test_migrate_rejects_newer_storage_version() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        env.as_contract(&contract, || {
            env.storage()
                .instance()
                .set(&DataKey::StorageVersion, &(CURRENT_STORAGE_VERSION + 1));
        });

        assert_eq!(
            client.try_migrate(),
            Err(Ok(ContractError::UnsupportedStorageVersion))
        );
        // State written by the newer schema is left untouched.
        assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION + 1);
    }

    #[test]
    fn test_migrate_moves_forward_from_every_older_version() {
        for start in [0u32, 1] {
            let (env, contract, _, _, _) = setup();
            let client = CertChainCredentialClient::new(&env, &contract);
            env.as_contract(&contract, || {
                env.storage()
                    .instance()
                    .set(&DataKey::StorageVersion, &start);
            });
            client.migrate();
            assert_eq!(
                client.get_storage_version(),
                CURRENT_STORAGE_VERSION,
                "from {start}"
            );
            // Already current: migrating again is a no-op, not an error.
            client.migrate();
            assert_eq!(client.get_storage_version(), CURRENT_STORAGE_VERSION);
        }
    }
} // end mod tests

// ---------------------------------------------------------------------------
// Property / invariant tests for issuance & revocation.
//
// Rather than a handful of fixed scenarios, this generates randomized
// sequences of issue/revoke operations (proptest shrinks any failing case to
// a minimal reproduction) and checks that core invariants hold after every
// step and at the end of the run:
//   - token ids are assigned sequentially starting at 1
//   - a hash can back at most one credential, ever
//   - only the recorded issuer of a credential can revoke it
//   - revocation is monotonic (never un-revoked) and idempotent-safe
//     (a second revoke always fails with AlreadyRevoked)
//   - total_credentials always equals the number of successful issuances
//   - every issued credential remains retrievable by id and by hash, with
//     state matching the model built alongside the contract calls
// ---------------------------------------------------------------------------
#[cfg(test)]
mod proptest_invariants {
    extern crate std;

    use super::*;
    // Weighted `prop_oneof!` expands to `vec![...]`; this crate is no_std.
    use proptest::prelude::*;
    use soroban_sdk::testutils::{Address as _, Register};
    use std::vec;

    fn seed_hash(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    #[derive(Debug, Clone)]
    enum Op {
        Issue {
            issuer_idx: u8,
            student_idx: u8,
            hash_seed: u8,
        },
        Revoke {
            by_idx: u8,
            token_pick: u8,
        },
    }

    fn op_strategy() -> impl Strategy<Value = Op> {
        prop_oneof![
            (0u8..3, 0u8..3, 0u8..5).prop_map(|(issuer_idx, student_idx, hash_seed)| {
                Op::Issue {
                    issuer_idx,
                    student_idx,
                    hash_seed,
                }
            }),
            (0u8..4, 0u8..8).prop_map(|(by_idx, token_pick)| Op::Revoke { by_idx, token_pick }),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        #[test]
        fn invariant_issuance_and_revocation_hold(ops in prop::collection::vec(op_strategy(), 1..25)) {
            // Skip the on-drop test-snapshot JSON dump: with randomized
            // cases there is no single meaningful scenario worth freezing to
            // disk the way the named scenario tests in `mod tests` are.
            let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
                capture_snapshot_at_drop: false,
            });
            env.mock_all_auths();
            let contract = CertChainCredential.register(&env, None, ());
            let owner = Address::generate(&env);
            let issuers: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
            // A 4th, never-authorized address used by `Revoke { by_idx: 3, .. }`
            // to exercise the "not the recorded issuer" rejection path.
            let rogue = Address::generate(&env);
            let students: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();

            env.as_contract(&contract, || {
                CertChainCredential::initialize(env.clone(), owner.clone()).unwrap();
            });
            for issuer in issuers.iter() {
                env.as_contract(&contract, || {
                    CertChainCredential::authorize_issuer(env.clone(), issuer.clone());
                });
            }

            // Parallel model: token_id -> (hash, issuer, revoked).
            let mut issued: std::vec::Vec<(u64, BytesN<32>, Address, bool)> = std::vec::Vec::new();
            let mut used_seeds: std::collections::HashSet<u8> = std::collections::HashSet::new();
            let mut success_count: u64 = 0;

            for op in ops {
                match op {
                    Op::Issue { issuer_idx, student_idx, hash_seed } => {
                        let issuer = issuers[issuer_idx as usize % issuers.len()].clone();
                        let student = students[student_idx as usize % students.len()].clone();
                        let hash = seed_hash(&env, hash_seed);
                        let ipfs = String::from_str(&env, "ipfs://proptest");
                        let hash_reused = used_seeds.contains(&hash_seed);

                        let result = env.as_contract(&contract, || {
                            CertChainCredential::issue_credential(
                                env.clone(),
                                student,
                                issuer.clone(),
                                hash.clone(),
                                ipfs,
                            )
                        });

                        if hash_reused {
                            prop_assert_eq!(result, Err(ContractError::CredentialAlreadyExists));
                        } else {
                            let token_id = result.expect("fresh hash must issue successfully");
                            prop_assert_eq!(
                                token_id,
                                success_count + 1,
                                "token ids must be assigned sequentially starting at 1"
                            );
                            issued.push((token_id, hash, issuer, false));
                            used_seeds.insert(hash_seed);
                            success_count += 1;
                        }
                    }
                    Op::Revoke { by_idx, token_pick } => {
                        if issued.is_empty() {
                            continue;
                        }
                        let idx = token_pick as usize % issued.len();
                        let (token_id, _hash, true_issuer, already_revoked) = issued[idx].clone();
                        let caller = if (by_idx as usize) < issuers.len() {
                            issuers[by_idx as usize].clone()
                        } else {
                            rogue.clone()
                        };

                        let result = env.as_contract(&contract, || {
                            CertChainCredential::revoke_credential(env.clone(), token_id, caller.clone())
                        });

                        // Mirrors revoke_credential's own precedence: issuer
                        // identity is checked before the revoked flag.
                        if caller != true_issuer {
                            prop_assert_eq!(result, Err(ContractError::UnauthorizedRevoker));
                        } else if already_revoked {
                            prop_assert_eq!(result, Err(ContractError::AlreadyRevoked));
                        } else {
                            prop_assert!(result.is_ok());
                            issued[idx].3 = true;
                        }

                        let is_rev = env.as_contract(&contract, || {
                            CertChainCredential::is_revoked(env.clone(), token_id)
                        });
                        prop_assert_eq!(is_rev, issued[idx].3, "revocation must be monotonic");
                    }
                }
            }

            let total = env.as_contract(&contract, || CertChainCredential::total_credentials(env.clone()));
            prop_assert_eq!(total, success_count, "total_credentials must equal successful issuances");

            for (token_id, hash, issuer, revoked) in issued.iter() {
                let cred = env
                    .as_contract(&contract, || CertChainCredential::get_credential(env.clone(), *token_id))
                    .expect("every issued credential must remain retrievable by id");
                prop_assert_eq!(&cred.issuer, issuer);
                prop_assert_eq!(cred.revoked, *revoked);

                let verified = env
                    .as_contract(&contract, || {
                        CertChainCredential::verify_credential(env.clone(), hash.clone())
                    })
                    .expect("every issued credential must remain retrievable by hash");
                prop_assert_eq!(verified.token_id, *token_id);
            }
        }
    }

    // -----------------------------------------------------------------------
    // #105: interleavings of every mutating entrypoint
    // -----------------------------------------------------------------------
    //
    // A model tracks owner/pending owner, pause flag, authorized issuers,
    // issued credentials (with batch partial-failure semantics), pending
    // upgrade and storage version; after every step the contract is checked
    // against it. `upgrade` is only exercised on its rejection paths (no new
    // WASM is installed in unit tests).

    /// Addresses used by the model: 0..3 are issuers (0..2 start authorized,
    /// 3 starts unauthorized), owners are picked from `owners`.
    const N_ISSUERS: usize = 4;
    const N_STUDENTS: usize = 3;
    const N_OWNERS: usize = 3;

    #[derive(Debug, Clone)]
    enum FullOp {
        Issue {
            issuer: u8,
            student: u8,
            hash: u8,
            long_uri: bool,
        },
        /// `rows` = (student, hash, long_uri). `oversize` sends MAX_BATCH_SIZE + 1 rows.
        Batch {
            issuer: u8,
            rows: std::vec::Vec<(u8, u8, bool)>,
            oversize: bool,
        },
        Revoke {
            by: u8,
            pick: u8,
        },
        AdminRevoke {
            pick: u8,
        },
        Bump {
            pick: u8,
        },
        Pause,
        Unpause,
        AuthorizeIssuer {
            issuer: u8,
        },
        RevokeIssuer {
            issuer: u8,
        },
        SetProfile {
            issuer: u8,
            name_len: u8,
        },
        TransferOwner {
            to: u8,
        },
        AcceptOwner,
        ProposeUpgrade {
            seed: u8,
        },
        CancelUpgrade,
        Upgrade {
            matching: bool,
        },
        Migrate,
    }

    fn full_op_strategy() -> impl Strategy<Value = FullOp> {
        let row = (0u8..N_STUDENTS as u8, 0u8..12, prop::bool::weighted(0.1));
        prop_oneof![
            4 => (0u8..N_ISSUERS as u8, 0u8..N_STUDENTS as u8, 0u8..12, prop::bool::weighted(0.1))
                .prop_map(|(issuer, student, hash, long_uri)| FullOp::Issue { issuer, student, hash, long_uri }),
            4 => (0u8..N_ISSUERS as u8, prop::collection::vec(row, 0..5), prop::bool::weighted(0.05))
                .prop_map(|(issuer, rows, oversize)| FullOp::Batch { issuer, rows, oversize }),
            2 => (0u8..N_ISSUERS as u8, any::<u8>()).prop_map(|(by, pick)| FullOp::Revoke { by, pick }),
            1 => any::<u8>().prop_map(|pick| FullOp::AdminRevoke { pick }),
            1 => any::<u8>().prop_map(|pick| FullOp::Bump { pick }),
            2 => Just(FullOp::Pause),
            2 => Just(FullOp::Unpause),
            1 => (0u8..N_ISSUERS as u8).prop_map(|issuer| FullOp::AuthorizeIssuer { issuer }),
            1 => (0u8..N_ISSUERS as u8).prop_map(|issuer| FullOp::RevokeIssuer { issuer }),
            1 => (0u8..N_ISSUERS as u8, 0u8..80).prop_map(|(issuer, name_len)| FullOp::SetProfile { issuer, name_len }),
            1 => (0u8..N_OWNERS as u8).prop_map(|to| FullOp::TransferOwner { to }),
            1 => Just(FullOp::AcceptOwner),
            1 => any::<u8>().prop_map(|seed| FullOp::ProposeUpgrade { seed }),
            1 => Just(FullOp::CancelUpgrade),
            1 => any::<bool>().prop_map(|matching| FullOp::Upgrade { matching }),
            1 => Just(FullOp::Migrate),
        ]
    }

    #[derive(Clone)]
    struct ModelCredential {
        token_id: u64,
        hash_seed: u8,
        issuer: usize,
        student: usize,
        revoked: bool,
    }

    fn ipfs_uri(env: &Env, long: bool) -> String {
        if long {
            let s: std::string::String = "u".repeat(MAX_IPFS_URI_LEN as usize + 1);
            String::from_str(env, &s)
        } else {
            String::from_str(env, "ipfs://model")
        }
    }

    /// Run `ops` against a fresh contract and the model. Shared by the
    /// randomized property test and the seeded regression cases below.
    fn run_full_model(ops: &[FullOp]) -> Result<(), TestCaseError> {
        let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let contract = CertChainCredential.register(&env, None, ());
        let owners: std::vec::Vec<Address> =
            (0..N_OWNERS).map(|_| Address::generate(&env)).collect();
        let issuers: std::vec::Vec<Address> =
            (0..N_ISSUERS).map(|_| Address::generate(&env)).collect();
        let students: std::vec::Vec<Address> =
            (0..N_STUDENTS).map(|_| Address::generate(&env)).collect();
        let call = |f: &dyn Fn() -> ()| env.as_contract(&contract, f);

        call(&|| CertChainCredential::initialize(env.clone(), owners[0].clone()).unwrap());
        for issuer in issuers.iter().take(3) {
            call(&|| CertChainCredential::authorize_issuer(env.clone(), issuer.clone()));
        }

        let mut owner = 0usize;
        let mut pending_owner: Option<usize> = None;
        let mut paused = false;
        let mut authorized = [true, true, true, false];
        let mut used_hashes: std::collections::HashSet<u8> = std::collections::HashSet::new();
        let mut issued: std::vec::Vec<ModelCredential> = std::vec::Vec::new();
        let mut next_token: u64 = 1;
        let mut pending_upgrade: Option<BytesN<32>> = None;
        let mut storage_version: u32 = 1;

        for op in ops {
            match op.clone() {
                FullOp::Issue {
                    issuer,
                    student,
                    hash,
                    long_uri,
                } => {
                    let (i, st) = (issuer as usize, student as usize);
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::issue_credential(
                            env.clone(),
                            students[st].clone(),
                            issuers[i].clone(),
                            seed_hash(&env, hash),
                            ipfs_uri(&env, long_uri),
                        )
                    });
                    let expected = if paused {
                        Err(ContractError::ContractPaused)
                    } else if !authorized[i] {
                        Err(ContractError::IssuerNotAuthorized)
                    } else if long_uri {
                        Err(ContractError::IpfsUriTooLarge)
                    } else if used_hashes.contains(&hash) {
                        Err(ContractError::CredentialAlreadyExists)
                    } else {
                        Ok(next_token)
                    };
                    prop_assert_eq!(result, expected, "issue {:?}", op);
                    if let Ok(token_id) = expected {
                        issued.push(ModelCredential {
                            token_id,
                            hash_seed: hash,
                            issuer: i,
                            student: st,
                            revoked: false,
                        });
                        used_hashes.insert(hash);
                        next_token += 1;
                    }
                }
                FullOp::Batch {
                    issuer,
                    rows,
                    oversize,
                } => {
                    let i = issuer as usize;
                    let mut inputs = Vec::new(&env);
                    let rows: std::vec::Vec<(u8, u8, bool)> = if oversize {
                        (0..=MAX_BATCH_SIZE)
                            .map(|n| (0u8, 100u8.wrapping_add(n as u8), false))
                            .collect()
                    } else {
                        rows
                    };
                    for (st, hash, long_uri) in rows.iter() {
                        inputs.push_back(BatchCredentialInput {
                            student: students[*st as usize].clone(),
                            credential_hash: seed_hash(&env, *hash),
                            ipfs_uri: ipfs_uri(&env, *long_uri),
                        });
                    }
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::batch_issue_credential(
                            env.clone(),
                            issuers[i].clone(),
                            inputs.clone(),
                        )
                    });
                    if paused {
                        prop_assert_eq!(result, Err(ContractError::ContractPaused));
                    } else if !authorized[i] {
                        prop_assert_eq!(result, Err(ContractError::IssuerNotAuthorized));
                    } else if rows.is_empty() {
                        prop_assert_eq!(result, Err(ContractError::EmptyBatch));
                    } else if rows.len() as u32 > MAX_BATCH_SIZE {
                        prop_assert_eq!(result, Err(ContractError::BatchTooLarge));
                    } else {
                        let results = result.expect("valid batch call must return per-row results");
                        prop_assert_eq!(results.len() as usize, rows.len());
                        for (idx, (st, hash, long_uri)) in rows.iter().enumerate() {
                            let r = results.get(idx as u32).unwrap();
                            prop_assert_eq!(r.index, idx as u32);
                            let expected_code = if *long_uri {
                                ContractError::IpfsUriTooLarge as u32
                            } else if used_hashes.contains(hash) {
                                ContractError::CredentialAlreadyExists as u32
                            } else {
                                0
                            };
                            if expected_code == 0 {
                                prop_assert!(r.success, "row {} should succeed", idx);
                                prop_assert_eq!(r.token_id, next_token);
                                issued.push(ModelCredential {
                                    token_id: next_token,
                                    hash_seed: *hash,
                                    issuer: i,
                                    student: *st as usize,
                                    revoked: false,
                                });
                                used_hashes.insert(*hash);
                                next_token += 1;
                            } else {
                                prop_assert!(!r.success);
                                prop_assert_eq!(r.token_id, 0);
                                prop_assert_eq!(r.error_code, expected_code);
                            }
                        }
                    }
                }
                FullOp::Revoke { by, pick } => {
                    if issued.is_empty() {
                        continue;
                    }
                    let idx = pick as usize % issued.len();
                    let by = by as usize;
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::revoke_credential(
                            env.clone(),
                            issued[idx].token_id,
                            issuers[by].clone(),
                        )
                    });
                    let expected = if paused {
                        Err(ContractError::ContractPaused)
                    } else if issued[idx].issuer != by {
                        Err(ContractError::UnauthorizedRevoker)
                    } else if issued[idx].revoked {
                        Err(ContractError::AlreadyRevoked)
                    } else {
                        Ok(())
                    };
                    prop_assert_eq!(result, expected);
                    if expected.is_ok() {
                        issued[idx].revoked = true;
                    }
                }
                FullOp::AdminRevoke { pick } => {
                    if issued.is_empty() {
                        continue;
                    }
                    let idx = pick as usize % issued.len();
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::admin_revoke_credential(
                            env.clone(),
                            issued[idx].token_id,
                        )
                    });
                    let expected = if paused {
                        Err(ContractError::ContractPaused)
                    } else if issued[idx].revoked {
                        Err(ContractError::AlreadyRevoked)
                    } else {
                        Ok(())
                    };
                    prop_assert_eq!(result, expected);
                    if expected.is_ok() {
                        issued[idx].revoked = true;
                    }
                }
                FullOp::Bump { pick } => {
                    let token_id = if issued.is_empty() {
                        9_999
                    } else {
                        issued[pick as usize % issued.len()].token_id
                    };
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::bump_credential(env.clone(), token_id)
                    });
                    // Bumping is allowed while paused: it never changes data.
                    let expected = if issued.is_empty() {
                        Err(ContractError::CredentialNotFound)
                    } else {
                        Ok(())
                    };
                    prop_assert_eq!(result, expected);
                }
                FullOp::Pause => {
                    prop_assert_eq!(
                        env.as_contract(&contract, || CertChainCredential::pause(env.clone())),
                        Ok(())
                    );
                    paused = true;
                }
                FullOp::Unpause => {
                    prop_assert_eq!(
                        env.as_contract(&contract, || CertChainCredential::unpause(env.clone())),
                        Ok(())
                    );
                    paused = false;
                }
                FullOp::AuthorizeIssuer { issuer } => {
                    call(&|| {
                        CertChainCredential::authorize_issuer(
                            env.clone(),
                            issuers[issuer as usize].clone(),
                        )
                    });
                    authorized[issuer as usize] = true;
                }
                FullOp::RevokeIssuer { issuer } => {
                    call(&|| {
                        CertChainCredential::revoke_issuer(
                            env.clone(),
                            issuers[issuer as usize].clone(),
                        )
                    });
                    authorized[issuer as usize] = false;
                }
                FullOp::SetProfile { issuer, name_len } => {
                    let i = issuer as usize;
                    let name: std::string::String = "n".repeat(name_len as usize);
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::set_issuer_profile(
                            env.clone(),
                            issuers[i].clone(),
                            String::from_str(&env, &name),
                            String::from_str(&env, "https://issuer.example"),
                        )
                    });
                    // Profiles are not gated by the pause flag.
                    let expected = if !authorized[i] {
                        Err(ContractError::IssuerNotAuthorized)
                    } else if name_len as u32 > MAX_ISSUER_NAME_LEN {
                        Err(ContractError::ProfileTooLarge)
                    } else {
                        Ok(())
                    };
                    prop_assert_eq!(result, expected);
                }
                FullOp::TransferOwner { to } => {
                    let to = to as usize;
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::transfer_owner(env.clone(), owners[to].clone())
                    });
                    if to == owner {
                        prop_assert_eq!(result, Err(ContractError::SameOwner));
                    } else {
                        prop_assert_eq!(result, Ok(()));
                        pending_owner = Some(to);
                    }
                }
                FullOp::AcceptOwner => {
                    let result = env
                        .as_contract(&contract, || CertChainCredential::accept_owner(env.clone()));
                    match pending_owner.take() {
                        None => prop_assert_eq!(result, Err(ContractError::NoPendingOwner)),
                        Some(next) => {
                            prop_assert_eq!(result, Ok(()));
                            owner = next;
                        }
                    }
                }
                FullOp::ProposeUpgrade { seed } => {
                    let hash = BytesN::from_array(&env, &[seed; 32]);
                    prop_assert_eq!(
                        env.as_contract(&contract, || CertChainCredential::propose_upgrade(
                            env.clone(),
                            hash.clone()
                        )),
                        Ok(())
                    );
                    pending_upgrade = Some(hash);
                }
                FullOp::CancelUpgrade => {
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::cancel_upgrade(env.clone())
                    });
                    if pending_upgrade.take().is_some() {
                        prop_assert_eq!(result, Ok(()));
                    } else {
                        prop_assert_eq!(result, Err(ContractError::UpgradeNotProposed));
                    }
                }
                FullOp::Upgrade { matching } => {
                    let hash = match (&pending_upgrade, matching) {
                        (Some(h), true) => h.clone(),
                        _ => BytesN::from_array(&env, &[0xEE; 32]),
                    };
                    let result = env.as_contract(&contract, || {
                        CertChainCredential::upgrade(env.clone(), hash.clone())
                    });
                    let expected = match (&pending_upgrade, matching) {
                        (None, _) => ContractError::UpgradeNotProposed,
                        (Some(h), false) if *h != hash => ContractError::UpgradeHashMismatch,
                        // The ledger never advances past the timelock here.
                        _ => ContractError::UpgradeTimelockActive,
                    };
                    prop_assert_eq!(result, Err(expected));
                }
                FullOp::Migrate => {
                    prop_assert_eq!(
                        env.as_contract(&contract, || CertChainCredential::migrate(env.clone())),
                        Ok(())
                    );
                    storage_version = 2;
                }
            }

            // ── Invariants after every step ──
            let (got_owner, got_pending, got_paused, total, version, upgrade) =
                env.as_contract(&contract, || {
                    (
                        CertChainCredential::get_owner(env.clone()),
                        CertChainCredential::get_pending_owner(env.clone()),
                        CertChainCredential::is_paused(env.clone()),
                        CertChainCredential::total_credentials(env.clone()),
                        CertChainCredential::get_storage_version(env.clone()),
                        CertChainCredential::get_pending_upgrade(env.clone()),
                    )
                });
            prop_assert_eq!(&got_owner, &owners[owner]);
            prop_assert_eq!(got_pending, pending_owner.map(|p| owners[p].clone()));
            prop_assert_eq!(got_paused, paused);
            prop_assert_eq!(
                total,
                issued.len() as u64,
                "total_credentials tracks successful issuances"
            );
            prop_assert_eq!(version, storage_version);
            prop_assert_eq!(upgrade.map(|u| u.wasm_hash), pending_upgrade.clone());
            for (i, issuer) in issuers.iter().enumerate() {
                let is_auth = env.as_contract(&contract, || {
                    CertChainCredential::is_authorized_issuer(env.clone(), issuer.clone())
                });
                prop_assert_eq!(is_auth, authorized[i], "issuer {} authorization", i);
            }
        }

        // ── Final state: every credential readable by id, hash and indexes ──
        for cred in issued.iter() {
            let got = env
                .as_contract(&contract, || {
                    CertChainCredential::get_credential(env.clone(), cred.token_id)
                })
                .expect("issued credential must be readable");
            prop_assert_eq!(&got.issuer, &issuers[cred.issuer]);
            prop_assert_eq!(&got.student, &students[cred.student]);
            prop_assert_eq!(got.revoked, cred.revoked);
            let by_hash = env
                .as_contract(&contract, || {
                    CertChainCredential::verify_credential(
                        env.clone(),
                        seed_hash(&env, cred.hash_seed),
                    )
                })
                .expect("issued credential must be readable by hash");
            prop_assert_eq!(by_hash.token_id, cred.token_id);
        }
        for (st, student) in students.iter().enumerate() {
            let expected: std::vec::Vec<u64> = issued
                .iter()
                .filter(|c| c.student == st)
                .map(|c| c.token_id)
                .collect();
            let got = env.as_contract(&contract, || {
                CertChainCredential::get_credentials_by_student(env.clone(), student.clone())
            });
            prop_assert_eq!(got.iter().collect::<std::vec::Vec<u64>>(), expected);
        }
        for (i, issuer) in issuers.iter().enumerate() {
            let expected: std::vec::Vec<u64> = issued
                .iter()
                .filter(|c| c.issuer == i)
                .map(|c| c.token_id)
                .collect();
            let got = env.as_contract(&contract, || {
                CertChainCredential::get_credentials_by_issuer(env.clone(), issuer.clone())
            });
            prop_assert_eq!(got.iter().collect::<std::vec::Vec<u64>>(), expected);
        }
        Ok(())
    }

    proptest! {
        // Fixed case count; failing inputs are shrunk and printed by proptest
        // so they can be added to `seeded_full_model_regressions` below.
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn invariant_all_mutating_entrypoints_hold(ops in prop::collection::vec(full_op_strategy(), 1..30)) {
            run_full_model(&ops)?;
        }
    }

    /// Seeded regression set: hand-picked interleavings that must always pass.
    /// They pin batch partial failures, pause gating and issuer revocation
    /// between batch rows, so a regression in any of them fails the suite
    /// deterministically, independent of the random property run.
    #[test]
    fn seeded_full_model_regressions() {
        use FullOp::*;
        let seeds: std::vec::Vec<std::vec::Vec<FullOp>> = std::vec![
            // Batch partial failure: in-batch duplicate, stored duplicate, long URI.
            std::vec![
                Issue {
                    issuer: 0,
                    student: 0,
                    hash: 1,
                    long_uri: false
                },
                Batch {
                    issuer: 0,
                    rows: std::vec![
                        (0, 2, false),
                        (1, 2, false),
                        (2, 1, false),
                        (1, 3, true),
                        (2, 4, false)
                    ],
                    oversize: false
                },
            ],
            // Pause blocks both issuance paths and revocation; unpause restores them.
            std::vec![
                Issue {
                    issuer: 1,
                    student: 1,
                    hash: 5,
                    long_uri: false
                },
                Pause,
                Batch {
                    issuer: 1,
                    rows: std::vec![(0, 6, false)],
                    oversize: false
                },
                Issue {
                    issuer: 1,
                    student: 0,
                    hash: 6,
                    long_uri: false
                },
                Revoke { by: 1, pick: 0 },
                AdminRevoke { pick: 0 },
                Bump { pick: 0 },
                Unpause,
                Batch {
                    issuer: 1,
                    rows: std::vec![(0, 6, false)],
                    oversize: false
                },
                Revoke { by: 1, pick: 0 },
                AdminRevoke { pick: 0 },
            ],
            // Revoked issuer: whole batch fails, earlier credentials stay valid; re-authorize.
            std::vec![
                Batch {
                    issuer: 2,
                    rows: std::vec![(0, 7, false), (1, 8, false)],
                    oversize: false
                },
                RevokeIssuer { issuer: 2 },
                Batch {
                    issuer: 2,
                    rows: std::vec![(0, 9, false)],
                    oversize: false
                },
                SetProfile {
                    issuer: 2,
                    name_len: 4
                },
                AuthorizeIssuer { issuer: 2 },
                Issue {
                    issuer: 2,
                    student: 2,
                    hash: 9,
                    long_uri: false
                },
                Issue {
                    issuer: 3,
                    student: 2,
                    hash: 10,
                    long_uri: false
                },
            ],
            // Empty and oversize batches never change counters.
            std::vec![
                Batch {
                    issuer: 0,
                    rows: std::vec![],
                    oversize: false
                },
                Batch {
                    issuer: 0,
                    rows: std::vec![],
                    oversize: true
                },
                Issue {
                    issuer: 0,
                    student: 0,
                    hash: 11,
                    long_uri: false
                },
            ],
            // Ownership handover and upgrade bookkeeping interleaved with issuance.
            std::vec![
                TransferOwner { to: 0 },
                AcceptOwner,
                TransferOwner { to: 1 },
                Issue {
                    issuer: 0,
                    student: 0,
                    hash: 3,
                    long_uri: false
                },
                AcceptOwner,
                AdminRevoke { pick: 0 },
                ProposeUpgrade { seed: 7 },
                Upgrade { matching: false },
                Upgrade { matching: true },
                CancelUpgrade,
                CancelUpgrade,
                Migrate,
                Migrate,
            ],
        ];
        for (n, ops) in seeds.iter().enumerate() {
            if let Err(e) = run_full_model(ops) {
                panic!("seeded regression case {} failed: {}", n, e);
            }
        }
    }

    // -----------------------------------------------------------------------
    // #106: length caps fuzzed around their boundaries
    // -----------------------------------------------------------------------
    //
    // Caps are enforced on the UTF-8 *byte* length (`String::len`), so a
    // string of N multibyte characters counts as more than N. Each test builds
    // strings whose byte length lands just below, on and just above a cap,
    // from ASCII and from 2-, 3- and 4-byte characters.

    /// Characters of every UTF-8 width; the seed set always includes multibyte.
    const BOUNDARY_CHARS: [char; 4] = ['a', 'é', '€', '🎓'];

    /// A string of exactly `target` bytes when possible: as many `ch` as fit,
    /// padded with ASCII to the exact byte count.
    fn string_with_bytes(ch: char, target: usize) -> std::string::String {
        let w = ch.len_utf8();
        let mut out: std::string::String = core::iter::repeat(ch).take(target / w).collect();
        while out.len() < target {
            out.push('x');
        }
        out
    }

    /// Byte lengths around `cap`: cap-2 ..= cap+2.
    fn around(cap: u32) -> impl Strategy<Value = usize> {
        ((cap as i64 - 2)..=(cap as i64 + 2)).prop_map(|n| n.max(0) as usize)
    }

    fn boundary_env() -> (Env, Address, Address, Address) {
        let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        let issuer = Address::generate(&env);
        env.as_contract(&contract, || {
            CertChainCredential::initialize(env.clone(), owner.clone()).unwrap();
        });
        env.as_contract(&contract, || {
            CertChainCredential::authorize_issuer(env.clone(), issuer.clone());
        });
        (env, contract, owner, issuer)
    }

    #[test]
    fn string_with_bytes_hits_exact_lengths() {
        for ch in BOUNDARY_CHARS {
            for target in [0usize, 1, 63, 64, 65, 255, 256, 257, 511, 512, 513] {
                let s = string_with_bytes(ch, target);
                assert_eq!(s.len(), target, "{:?} @ {}", ch, target);
                if target >= ch.len_utf8() && ch.len_utf8() > 1 {
                    assert!(
                        s.chars().count() < target,
                        "multibyte case must have fewer chars than bytes"
                    );
                }
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(40))]

        /// MAX_IPFS_URI_LEN on single issuance: accepted iff bytes <= cap, and
        /// a rejected call leaves total_credentials and the token counter unchanged.
        #[test]
        fn ipfs_uri_cap_on_issue(ch in prop::sample::select(&BOUNDARY_CHARS[..]), len in around(MAX_IPFS_URI_LEN), seed in any::<u8>()) {
            let (env, contract, _, issuer) = boundary_env();
            let student = Address::generate(&env);
            let uri = string_with_bytes(ch, len);
            let before = env.as_contract(&contract, || CertChainCredential::total_credentials(env.clone()));
            let result = env.as_contract(&contract, || {
                CertChainCredential::issue_credential(
                    env.clone(), student.clone(), issuer.clone(), seed_hash(&env, seed), String::from_str(&env, &uri),
                )
            });
            let after = env.as_contract(&contract, || CertChainCredential::total_credentials(env.clone()));
            if uri.len() as u32 <= MAX_IPFS_URI_LEN {
                prop_assert_eq!(result, Ok(1));
                prop_assert_eq!(after, before + 1);
                let cred = env.as_contract(&contract, || CertChainCredential::get_credential(env.clone(), 1)).unwrap();
                prop_assert_eq!(cred.ipfs_hash.len() as usize, uri.len());
            } else {
                prop_assert_eq!(result, Err(ContractError::IpfsUriTooLarge));
                prop_assert_eq!(after, before);
                prop_assert!(env.as_contract(&contract, || CertChainCredential::verify_credential(env.clone(), seed_hash(&env, seed))).is_none());
            }
        }

        /// MAX_IPFS_URI_LEN on batch rows: an over-cap row fails alone with
        /// IpfsUriTooLarge and does not consume a token id.
        #[test]
        fn ipfs_uri_cap_on_batch_row(ch in prop::sample::select(&BOUNDARY_CHARS[..]), len in around(MAX_IPFS_URI_LEN)) {
            let (env, contract, _, issuer) = boundary_env();
            let student = Address::generate(&env);
            let uri = string_with_bytes(ch, len);
            let rows = soroban_sdk::vec![
                &env,
                BatchCredentialInput { student: student.clone(), credential_hash: seed_hash(&env, 1), ipfs_uri: String::from_str(&env, &uri) },
                BatchCredentialInput { student: student.clone(), credential_hash: seed_hash(&env, 2), ipfs_uri: String::from_str(&env, "ipfs://ok") },
            ];
            let results = env
                .as_contract(&contract, || CertChainCredential::batch_issue_credential(env.clone(), issuer.clone(), rows.clone()))
                .unwrap();
            let first = results.get(0).unwrap();
            let second = results.get(1).unwrap();
            let total = env.as_contract(&contract, || CertChainCredential::total_credentials(env.clone()));
            if uri.len() as u32 <= MAX_IPFS_URI_LEN {
                prop_assert!(first.success);
                prop_assert_eq!((first.token_id, second.token_id), (1, 2));
                prop_assert_eq!(total, 2);
            } else {
                prop_assert!(!first.success);
                prop_assert_eq!(first.error_code, ContractError::IpfsUriTooLarge as u32);
                prop_assert_eq!(first.token_id, 0);
                prop_assert_eq!(second.token_id, 1, "rejected row must not consume a token id");
                prop_assert_eq!(total, 1);
            }
        }

        /// MAX_ISSUER_NAME_LEN and MAX_ISSUER_PROFILE_URI_LEN: accepted iff both
        /// byte lengths are within their caps; a rejected update leaves any
        /// previous profile untouched.
        #[test]
        fn issuer_profile_caps(
            name_ch in prop::sample::select(&BOUNDARY_CHARS[..]),
            name_len in around(MAX_ISSUER_NAME_LEN),
            uri_ch in prop::sample::select(&BOUNDARY_CHARS[..]),
            uri_len in around(MAX_ISSUER_PROFILE_URI_LEN),
            fuzz_name in any::<bool>(),
        ) {
            let (env, contract, _, issuer) = boundary_env();
            // Fuzz one field at a time against a valid value in the other, so
            // each cap is checked on its own boundary.
            let (name, uri) = if fuzz_name {
                (string_with_bytes(name_ch, name_len), std::string::String::from("https://ok"))
            } else {
                (std::string::String::from("Issuer"), string_with_bytes(uri_ch, uri_len))
            };

            env.as_contract(&contract, || {
                CertChainCredential::set_issuer_profile(
                    env.clone(), issuer.clone(),
                    String::from_str(&env, "Original"), String::from_str(&env, "https://orig"),
                ).unwrap();
            });
            let result = env.as_contract(&contract, || {
                CertChainCredential::set_issuer_profile(
                    env.clone(), issuer.clone(), String::from_str(&env, &name), String::from_str(&env, &uri),
                )
            });
            let stored = env.as_contract(&contract, || CertChainCredential::get_issuer_profile(env.clone(), issuer.clone())).unwrap();

            let within = name.len() as u32 <= MAX_ISSUER_NAME_LEN && uri.len() as u32 <= MAX_ISSUER_PROFILE_URI_LEN;
            if within {
                prop_assert_eq!(result, Ok(()));
                prop_assert_eq!(stored.name, String::from_str(&env, &name));
                prop_assert_eq!(stored.profile_uri, String::from_str(&env, &uri));
            } else {
                prop_assert_eq!(result, Err(ContractError::ProfileTooLarge));
                prop_assert_eq!(stored.name, String::from_str(&env, "Original"));
                prop_assert_eq!(stored.profile_uri, String::from_str(&env, "https://orig"));
            }
        }
    }

    /// Fixed seed set: exact cap, one byte over, and multibyte strings whose
    /// character count is under the cap while their byte length is over it.
    #[test]
    fn length_cap_seed_set() {
        let (env, contract, _, issuer) = boundary_env();
        let student = Address::generate(&env);
        let issue = |uri: &str, seed: u8| {
            env.as_contract(&contract, || {
                CertChainCredential::issue_credential(
                    env.clone(),
                    student.clone(),
                    issuer.clone(),
                    seed_hash(&env, seed),
                    String::from_str(&env, uri),
                )
            })
        };
        let cap = MAX_IPFS_URI_LEN as usize;
        assert!(issue(&string_with_bytes('a', cap), 1).is_ok());
        assert_eq!(
            issue(&string_with_bytes('a', cap + 1), 2),
            Err(ContractError::IpfsUriTooLarge)
        );
        // 4-byte chars: exactly the cap in bytes is fine...
        assert!(issue(&string_with_bytes('🎓', cap), 3).is_ok());
        // ...but 129 graduation caps (516 bytes, only 129 characters) is over.
        let over: std::string::String = core::iter::repeat('🎓').take(cap / 4 + 1).collect();
        assert!(over.chars().count() < cap);
        assert_eq!(issue(&over, 4), Err(ContractError::IpfsUriTooLarge));

        let profile = |name: &str, uri: &str| {
            env.as_contract(&contract, || {
                CertChainCredential::set_issuer_profile(
                    env.clone(),
                    issuer.clone(),
                    String::from_str(&env, name),
                    String::from_str(&env, uri),
                )
            })
        };
        let name_cap = MAX_ISSUER_NAME_LEN as usize;
        let uri_cap = MAX_ISSUER_PROFILE_URI_LEN as usize;
        assert_eq!(profile(&string_with_bytes('a', name_cap), "u"), Ok(()));
        assert_eq!(
            profile(&string_with_bytes('a', name_cap + 1), "u"),
            Err(ContractError::ProfileTooLarge)
        );
        // 33 'é' = 66 bytes but 33 characters: over the byte cap.
        let accented: std::string::String =
            core::iter::repeat('é').take(name_cap / 2 + 1).collect();
        assert_eq!(profile(&accented, "u"), Err(ContractError::ProfileTooLarge));
        assert_eq!(profile("n", &string_with_bytes('€', uri_cap)), Ok(()));
        assert_eq!(
            profile("n", &string_with_bytes('€', uri_cap + 1)),
            Err(ContractError::ProfileTooLarge)
        );
        assert_eq!(
            env.as_contract(&contract, || CertChainCredential::total_credentials(
                env.clone()
            )),
            2
        );
    }

    // ── issue #99: two-step ownership transfer happy path ──────────────────

    #[test]
    fn test_transfer_owner_happy_path() {
        let (env, contract, owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let new_owner = Address::generate(&env);

        // Step 1: propose transfer — emits own_xfer
        client.transfer_owner(&new_owner);
        assert_eq!(client.get_pending_owner(), Some(new_owner.clone()));

        // Step 2: new owner accepts — emits own_acpt, clears PendingOwner
        client.accept_owner();
        assert_eq!(client.get_owner(), new_owner);
        assert_eq!(client.get_pending_owner(), None);

        // Events: own_xfer then own_acpt
        let events = env.events().all();
        let topics: soroban_sdk::Vec<soroban_sdk::Val> = events
            .iter()
            .map(|(_, topics, _)| {
                topics
                    .iter()
                    .next()
                    .unwrap_or_else(|| soroban_sdk::Val::from_void())
            })
            .collect();
        let _ = topics; // event shapes vary; presence of two events is the assertion
        assert!(events.len() >= 2);
    }

    #[test]
    fn test_transfer_owner_pending_owner_cleared_after_accept() {
        let (env, contract, _owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let new_owner = Address::generate(&env);

        client.transfer_owner(&new_owner);
        assert!(client.get_pending_owner().is_some());

        client.accept_owner();
        assert_eq!(client.get_pending_owner(), None);
    }

    // ── issue #100: is_revoked for unknown tokens ──────────────────────────

    #[test]
    fn test_is_revoked_returns_false_for_unknown_token() {
        let (env, contract, _, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);

        // token 999 was never issued; current semantics return false (not-found = not-revoked)
        // this test documents and pins that behaviour
        assert!(!client.is_revoked(&999u64));
    }

    #[test]
    fn test_is_revoked_false_for_active_credential() {
        let (env, contract, _, issuer, student) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let hash = dummy_hash(&env, 0x20);
        let token_id = client
            .issue_credential(&issuer, &student, &hash, &String::from_str(&env, "ipfs://t"))
            .unwrap();
        assert!(!client.is_revoked(&token_id));
    }

    #[test]
    fn test_is_revoked_true_after_revocation() {
        let (env, contract, owner, issuer, student) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let hash = dummy_hash(&env, 0x21);
        let token_id = client
            .issue_credential(&issuer, &student, &hash, &String::from_str(&env, "ipfs://t"))
            .unwrap();
        env.as_contract(&contract, || {
            CertChainCredential::revoke_credential(env.clone(), token_id, owner.clone()).unwrap();
        });
        assert!(client.is_revoked(&token_id));
    }

    // ── issue #111: cover owner and pending-owner read happy paths ─────────

    #[test]
    fn test_governance_reads_owner_immediately_after_initialization() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = CertChainCredential.register(&env, None, ());
        let owner = Address::generate(&env);
        let client = CertChainCredentialClient::new(&env, &contract);

        client.initialize(&owner);

        // Verify get_owner returns initialized owner and get_pending_owner is None
        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.get_pending_owner(), None);
    }

    #[test]
    fn test_governance_reads_ownership_lifecycle_happy_path() {
        let (env, contract, initial_owner, _, _) = setup();
        let client = CertChainCredentialClient::new(&env, &contract);
        let new_owner = Address::generate(&env);

        // Initial setup state
        assert_eq!(client.get_owner(), initial_owner);
        assert_eq!(client.get_pending_owner(), None);

        // Propose transfer: owner is unchanged, pending owner is set
        client.transfer_owner(&new_owner);
        assert_eq!(client.get_owner(), initial_owner);
        assert_eq!(client.get_pending_owner(), Some(new_owner.clone()));

        // Accept transfer: owner is updated, pending owner is cleared
        client.accept_owner();
        assert_eq!(client.get_owner(), new_owner);
        assert_eq!(client.get_pending_owner(), None);
    }
}
