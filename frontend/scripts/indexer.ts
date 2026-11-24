import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true }); // Load .env if running directly
import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { createClient } from '@supabase/supabase-js';
import { getConfiguredContractId } from '../src/lib/runtimeConfig';
import { evaluateIndexerLag, formatLagMetric } from './indexerHealth';

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!RPC_URL || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing required environment variables');
    process.exit(1);
}

// Parse --reset-from <ledger> flag for backfill/reset.
// Usage: npx ts-node indexer.ts --reset-from 1234567
// Resets the stored cursor to the given ledger so the next run replays from there.
const resetFromArg = process.argv.indexOf('--reset-from');
const RESET_FROM_LEDGER: number | null = resetFromArg !== -1
    ? parseInt(process.argv[resetFromArg + 1] ?? '', 10)
    : null;
if (RESET_FROM_LEDGER !== null && (!Number.isInteger(RESET_FROM_LEDGER) || RESET_FROM_LEDGER < 0)) {
    console.error('--reset-from requires a non-negative integer ledger sequence number');
    process.exit(1);
}

// Resolve the credential NFT contract ID through the same helper the app uses
// so a single env change (NEXT_PUBLIC_CREDENTIAL_NFT_CONTRACT_ID) keeps the
// indexer and the app pointed at the same contract.
let CONTRACT_ID: string;
try {
    CONTRACT_ID = getConfiguredContractId('CREDENTIAL_NFT');
} catch (e) {
    console.error('Invalid credential NFT contract configuration:', e instanceof Error ? e.message : e);
    process.exit(1);
}

// Narrowed after the env guard above so nested closures see a definite string.
const contractId: string = CONTRACT_ID;

const server = new rpc.Server(RPC_URL);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
});

const EVENT_BATCH_SIZE = 1000;
const POLL_INTERVAL_MS = 5000;
const MAX_LEDGER_RANGE = 10000;
const MAX_PAGINATION_PAGES = 500;

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Thrown when a processEvent call fails; holds the event id for quarantine logging. */
class EventProcessingError extends Error {
    constructor(public readonly eventId: string, cause: unknown) {
        super(`Failed to process event ${eventId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.cause = cause;
    }
}

async function processEvent(event: rpc.Api.EventResponse) {
    // The getEvents filter already restricts results to our contract, so we only
    // need to guard the event kind here.
    if (event.type !== 'contract') return;

    try {
        // In @stellar/stellar-sdk v15, getEvents already decodes topic/value to
        // xdr.ScVal — pass them straight to scValToNative (no base64 fromXDR).
        const topics = event.topic.map((val) => scValToNative(val));
        const eventName = topics[0]?.toString();
        const data = scValToNative(event.value);

        console.log(`Processing event: ${eventName} at ledger ${event.ledger}`);

        if (eventName === 'cred_iss') {
            const tokenId = topics[1]?.toString();
            // Data is (student, issuer, credential_hash, ipfs_uri)
            const student = data[0]?.toString();
            const issuer = data[1]?.toString();
            const credentialHash = bytesToHex(data[2]);
            const ipfsUri = data[3]?.toString();
            // ipfsUri is 'ipfs://<hash>'
            const ipfsHash = ipfsUri?.replace('ipfs://', '') || '';

            // Ensure institution exists (or we just map by wallet_address)
            const { data: instData } = await supabase
                .from('institutions')
                .select('id')
                .eq('wallet_address', issuer)
                .maybeSingle();

            const institutionId = instData?.id || null;

            // Ensure student exists
            const { data: stuData } = await supabase
                .from('students')
                .select('id')
                .eq('wallet_address', student)
                .maybeSingle();
            
            const studentId = stuData?.id || null;

            const { error } = await supabase
                .from('credentials')
                .upsert({
                    token_id: tokenId,
                    student_id: studentId,
                    student_wallet_address: student,
                    institution_id: institutionId,
                    issuer_wallet_address: issuer,
                    ipfs_hash: ipfsHash,
                    blockchain_hash: credentialHash,
                    metadata: {}, // Empty for indexed-only ones if not known
                    issued_at: new Date(event.ledgerClosedAt).toISOString(),
                    revoked: false
                }, { onConflict: 'token_id' });
            
            if (error) console.error('Error inserting credential:', error);
        } else if (eventName === 'cred_rev') {
            const tokenId = topics[1]?.toString();
            const { error } = await supabase
                .from('credentials')
                .update({
                    revoked: true,
                    revoked_at: new Date(event.ledgerClosedAt).toISOString(),
                    revocation_source: 'issuer',
                })
                .eq('token_id', tokenId);

            if (error) console.error('Error revoking credential:', error);
        } else if (eventName === 'cred_rev_owner') {
            const tokenId = topics[1]?.toString();
            const { error } = await supabase
                .from('credentials')
                .update({
                    revoked: true,
                    revoked_at: new Date(event.ledgerClosedAt).toISOString(),
                    revocation_source: 'platform',
                })
                .eq('token_id', tokenId);

            if (error) console.error('Error revoking credential (platform override):', error);
        } else if (eventName === 'iss_auth') {
            const issuer = data?.toString();
            const { error } = await supabase
                .from('institutions')
                .update({ verified: true, status: 'verified' })
                .eq('wallet_address', issuer);
            
            if (error) console.error('Error authorizing issuer:', error);
        } else if (eventName === 'iss_rev') {
            const issuer = data?.toString();
            const { error } = await supabase
                .from('institutions')
                .update({ verified: false, status: 'suspended' })
                .eq('wallet_address', issuer);
            
            if (error) console.error('Error revoking issuer:', error);
        }
    } catch (e) {
        console.error('Error decoding/processing event:', e);
    }
}

async function run() {
    console.log('Starting Acredia off-chain indexer...');

    // Apply --reset-from before the main loop so the first iteration uses the new cursor.
    if (RESET_FROM_LEDGER !== null) {
        const startLedgerForReset = RESET_FROM_LEDGER > 0 ? RESET_FROM_LEDGER - 1 : 0;
        const { error } = await supabase
            .from('indexer_state')
            .upsert({ id: 'main', last_ledger: startLedgerForReset });
        if (error) {
            console.error('Failed to reset cursor:', error.message);
            process.exit(1);
        }
        console.log(`Cursor reset: will replay from ledger ${RESET_FROM_LEDGER}`);
    }

    // Alert only on a threshold crossing; the metric itself is logged every poll.
    let lagAlertActive = false;

    while (true) {
        try {
            // Get latest network ledger
            const latestLedgerResponse = await server.getLatestLedger();
            const networkLatestLedger = latestLedgerResponse.sequence;

            // Get last synced ledger from persistent Supabase state.
            // On a fresh deployment (no row yet) the indexer starts from the current
            // ledger to avoid replaying the entire chain history. To backfill from an
            // earlier ledger, restart with: --reset-from <ledger>
            let { data: stateData } = await supabase
                .from('indexer_state')
                .select('last_ledger')
                .eq('id', 'main')
                .maybeSingle();

            if (!stateData) {
                // Initialize if not present, starting from current ledger
                await supabase.from('indexer_state').insert({ id: 'main', last_ledger: networkLatestLedger });
                stateData = { last_ledger: networkLatestLedger };
            }

            // #80: emit a health metric every poll and alert when the newest
            // indexed ledger is more than 24 hours behind the network head.
            const lag = evaluateIndexerLag({
                lastIndexedLedger: stateData.last_ledger,
                latestLedger: networkLatestLedger,
                latestLedgerClosedAt: latestLedgerResponse.ledgerClosedAt,
            });
            console.log(formatLagMetric(lag));
            if (lag.alert && !lagAlertActive) {
                console.error(`[ALERT] ${lag.message}`);
                lagAlertActive = true;
            } else if (!lag.alert && lagAlertActive) {
                console.log(`Indexer lag recovered: ${lag.message}`);
                lagAlertActive = false;
            }

            let startLedger = stateData.last_ledger + 1;

            if (startLedger > networkLatestLedger) {
                // Up to date
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                continue;
            }

            // Fetch events in batches
            let endLedger = Math.min(startLedger + MAX_LEDGER_RANGE, networkLatestLedger);
            console.log(`Syncing ledgers ${startLedger} to ${endLedger}`);

            let cursor: string | undefined = undefined;
            let eventsProcessed = 0;
            let hasMore = true;
            let pageCount = 0;
            const failedEventIds: string[] = [];
            let lastSuccessfulLedger = startLedger - 1;

            while (hasMore) {
                if (pageCount >= MAX_PAGINATION_PAGES) {
                    throw new Error(
                        `Pagination safety limit reached (${MAX_PAGINATION_PAGES} pages) while syncing ledgers ${startLedger}–${endLedger}. Aborting to avoid infinite loop.`,
                    );
                }

                const filters = [{ type: 'contract' as const, contractIds: [contractId] }];
                // The RPC accepts exactly one of startLedger / cursor — use the
                // cursor for subsequent pages so we don't re-fetch the first page.
                const request: rpc.Server.GetEventsRequest = cursor
                    ? { filters, cursor, limit: EVENT_BATCH_SIZE }
                    : { filters, startLedger, limit: EVENT_BATCH_SIZE };

                const response = await server.getEvents(request);
                const events = response.events ?? [];

                for (const event of events) {
                    try {
                        await processEvent(event);
                        eventsProcessed++;
                        lastSuccessfulLedger = Math.max(lastSuccessfulLedger, event.ledger);
                    } catch (e) {
                        const eventId = `${event.ledger}:${event.txHash ?? 'unknown'}`;
                        failedEventIds.push(eventId);
                        console.error(new EventProcessingError(eventId, e).message);
                    }
                }

                pageCount++;
                cursor = response.cursor;
                hasMore = events.length === EVENT_BATCH_SIZE && Boolean(cursor);
            }

            if (failedEventIds.length > 0) {
                console.error(
                    `Quarantined ${failedEventIds.length} event(s) in ledgers ${startLedger}–${endLedger}: ${failedEventIds.join(', ')}`,
                );
            }

            // Persist progress up to the last successfully processed ledger so a
            // failed event is retried on the next poll instead of being skipped.
            const nextLedger = Math.max(lastSuccessfulLedger + 1, startLedger);
            await supabase
                .from('indexer_state')
                .update({ last_ledger: nextLedger - 1 })
                .eq('id', 'main');

            console.log(`Synced up to ledger ${nextLedger - 1} (${eventsProcessed} events)`);
        } catch (e) {
            console.error('Indexer loop error:', e);
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }
    }
}

run().catch((e) => {
    console.error('Fatal indexer error:', e);
    process.exit(1);
});
