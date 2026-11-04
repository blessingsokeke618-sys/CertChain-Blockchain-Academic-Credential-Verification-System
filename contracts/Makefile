# Makefile for CertChain Soroban Smart Contract
# Prerequisites: cargo, stellar-cli installed
#
# Quick start:
#   make build          — compile WASM
#   make test           — run full test suite (unit + property)
#   make deploy-testnet — build and deploy to testnet
#   make fetch-info     — read contract name/version from live testnet contract
#   make check-issuer ISSUER=<GADDR> — check if a wallet is authorized
#   make check-paused   — check if the contract is currently paused

CONTRACT_NAME    := certchain-credential
WASM_PATH        := target/wasm32v1-none/release/acredia_stellar.wasm
TESTNET_NETWORK  := testnet
MAINNET_NETWORK  := mainnet

# Deployed testnet contract — override with CERTCHAIN_CONTRACT_ID env var.
CERTCHAIN_CONTRACT_ID ?= CARWFW27MJ3OJADAUAHI3TDFHIL62YMLVEKTUTMSNXOMH7JJTNZKC3DK

# Stellar CLI identity names (set up with: stellar keys generate --network testnet <name>)
TESTNET_DEPLOYER ?= test-deployer
MAINNET_DEPLOYER ?= mainnet-deployer
OWNER_IDENTITY   ?= owner

.PHONY: all build test test-verbose test-property \
        deploy-testnet deploy-mainnet initialize-testnet \
        fetch-info check-issuer check-owner check-paused check-total \
        authorize-issuer revoke-issuer bump-credential \
        pause unpause \
        bindings clean format setup help

# ──────────────────────────────────────────────────────────────────────────────
# Default
# ──────────────────────────────────────────────────────────────────────────────

all: build

help:
	@echo ""
	@echo "CertChain Contract — Makefile targets"
	@echo "──────────────────────────────────────────────────────────────────"
	@echo "  make build                     Compile WASM (optimized release)"
	@echo "  make test                      Run unit + property tests"
	@echo "  make test-verbose              Run tests with output"
	@echo "  make deploy-testnet            Build + deploy to Stellar testnet"
	@echo "  make initialize-testnet        Initialize a freshly-deployed contract"
	@echo "  make fetch-info                Read contract name/version from chain"
	@echo "  make check-owner               Read the current contract owner"
	@echo "  make check-paused              Check if the contract is paused"
	@echo "  make check-total               Read total credentials issued"
	@echo "  make check-issuer ISSUER=<G..> Check if an address is authorized"
	@echo "  make authorize-issuer ISSUER=<G..>  Authorize a new issuer (owner only)"
	@echo "  make revoke-issuer ISSUER=<G..>     Revoke an issuer (owner only)"
	@echo "  make bump-credential TOKEN=<id>     Extend a credential's TTL"
	@echo "  make pause                     Pause the contract (owner only)"
	@echo "  make unpause                   Unpause the contract (owner only)"
	@echo "  make bindings                  Generate TypeScript bindings"
	@echo "  make clean                     Remove build artifacts"
	@echo "  make format                    Format Rust source"
	@echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────────────────────────────────────

setup:
	rustup target add wasm32v1-none

format:
	cargo fmt

build: setup
	cargo build --target wasm32v1-none --release
	stellar contract optimize --wasm $(WASM_PATH)
	@echo ""
	@echo "✅ Build complete: $(WASM_PATH)"
	@echo "   Run 'make test' to verify correctness before deploying."

# ──────────────────────────────────────────────────────────────────────────────
# Test
# ──────────────────────────────────────────────────────────────────────────────

test:
	cargo test

test-verbose:
	cargo test -- --nocapture

# Runs only the property-based tests (proptest / quickcheck).
test-property:
	cargo test property_ -- --nocapture

# ──────────────────────────────────────────────────────────────────────────────
# Deploy
# ──────────────────────────────────────────────────────────────────────────────

deploy-testnet: build
	@echo ""
	@echo "🚀 Deploying to Stellar testnet..."
	@echo "   Identity: $(TESTNET_DEPLOYER)"
	@echo "   Run 'make initialize-testnet CONTRACT_ID=<returned-id>' after this."
	stellar contract deploy \
		--wasm $(WASM_PATH) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER)

# After deploying, call initialize with the deployer as owner.
# Usage: make initialize-testnet CONTRACT_ID=C...
initialize-testnet:
	@test -n "$(CONTRACT_ID)" || (echo "❌ Usage: make initialize-testnet CONTRACT_ID=<id>" && exit 1)
	stellar contract invoke \
		--id $(CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER) \
		-- initialize \
		--owner $$(stellar keys address $(TESTNET_DEPLOYER))
	@echo "✅ Contract initialized. Owner: $$(stellar keys address $(TESTNET_DEPLOYER))"

deploy-mainnet: build
	@echo ""
	@echo "⚠️  Deploying to Stellar MAINNET. This uses real XLM."
	@echo "   Read docs/mainnet-readiness.md before proceeding."
	@echo "   Press Ctrl-C to abort, or wait 5 seconds..."
	@sleep 5
	stellar contract deploy \
		--wasm $(WASM_PATH) \
		--network $(MAINNET_NETWORK) \
		--source $(MAINNET_DEPLOYER)

# ──────────────────────────────────────────────────────────────────────────────
# Read-only contract queries (no signature needed)
# ──────────────────────────────────────────────────────────────────────────────

# Reads get_contract_info() — confirms the contract is alive and returns its
# version string. Safe to run as a health check.
fetch-info:
	@echo "📋 Contract info ($(CERTCHAIN_CONTRACT_ID)):"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER) \
		-- get_contract_info

check-owner:
	@echo "👤 Contract owner:"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER) \
		-- get_owner

check-paused:
	@echo "⏸️  Contract paused:"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER) \
		-- is_paused

check-total:
	@echo "📊 Total credentials issued:"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER) \
		-- total_credentials

# Usage: make check-issuer ISSUER=GABCDEF...
check-issuer:
	@test -n "$(ISSUER)" || (echo "❌ Usage: make check-issuer ISSUER=<stellar-address>" && exit 1)
	@echo "🔐 Is $(ISSUER) authorized:"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER) \
		-- is_authorized_issuer \
		--issuer $(ISSUER)

# Usage: make bump-credential TOKEN=42
bump-credential:
	@test -n "$(TOKEN)" || (echo "❌ Usage: make bump-credential TOKEN=<token-id>" && exit 1)
	@echo "⏰ Bumping TTL for credential #$(TOKEN):"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(TESTNET_DEPLOYER) \
		-- bump_credential \
		--token_id $(TOKEN)

# ──────────────────────────────────────────────────────────────────────────────
# Owner-only operations (require OWNER_IDENTITY to be set up in stellar-cli)
# ──────────────────────────────────────────────────────────────────────────────

# Usage: make authorize-issuer ISSUER=GABCDEF...
authorize-issuer:
	@test -n "$(ISSUER)" || (echo "❌ Usage: make authorize-issuer ISSUER=<stellar-address>" && exit 1)
	@echo "✅ Authorizing issuer: $(ISSUER)"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(OWNER_IDENTITY) \
		-- authorize_issuer \
		--issuer $(ISSUER)

# Usage: make revoke-issuer ISSUER=GABCDEF...
revoke-issuer:
	@test -n "$(ISSUER)" || (echo "❌ Usage: make revoke-issuer ISSUER=<stellar-address>" && exit 1)
	@echo "🚫 Revoking issuer: $(ISSUER)"
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(OWNER_IDENTITY) \
		-- revoke_issuer \
		--issuer $(ISSUER)

pause:
	@echo "⏸️  Pausing contract (emergency use only)..."
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(OWNER_IDENTITY) \
		-- pause

unpause:
	@echo "▶️  Unpausing contract..."
	stellar contract invoke \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--source $(OWNER_IDENTITY) \
		-- unpause

# ──────────────────────────────────────────────────────────────────────────────
# TypeScript bindings
# ──────────────────────────────────────────────────────────────────────────────

# Generates TypeScript bindings from the WASM ABI.
# Requires: build step completed, CONTRACT_ID set.
# The output is written to ../frontend/src/contracts/ and checked in.
bindings: build
	@test -n "$(CERTCHAIN_CONTRACT_ID)" || (echo "❌ Set CERTCHAIN_CONTRACT_ID" && exit 1)
	stellar contract bindings typescript \
		--wasm $(WASM_PATH) \
		--id $(CERTCHAIN_CONTRACT_ID) \
		--network $(TESTNET_NETWORK) \
		--output-dir ../frontend/src/contracts
	@echo "✅ TypeScript bindings written to ../frontend/src/contracts/"

# ──────────────────────────────────────────────────────────────────────────────
# Housekeeping
# ──────────────────────────────────────────────────────────────────────────────

clean:
	cargo clean
