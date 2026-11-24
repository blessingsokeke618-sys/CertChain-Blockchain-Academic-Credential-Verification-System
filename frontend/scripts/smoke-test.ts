import {
    Address,
    Contract,
    Keypair,
    nativeToScVal,
    rpc,
    scValToNative,
    StrKey,
    TimeoutInfinite,
    TransactionBuilder,
    xdr,
} from '@stellar/stellar-sdk';
import { createKeypairSigner } from '../src/lib/stellarSigner';
import {
    credentialHashHexToScVal,
    normalizeCredentialHashHex,
} from '../src/lib/credentialHashEncoding';

interface NetworkConfig {
    rpcUrl: string;
    networkPassphrase: string;
    networkName: string;
}

// Canonical SDF endpoints, mirrored from frontend/src/lib/runtimeConfig.ts so the
// smoke test can select a network without importing the Next.js runtime config.
const NETWORKS: Record<string, NetworkConfig> = {
    testnet: {
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        networkName: 'testnet',
    },
    mainnet: {
        rpcUrl: 'https://mainnet.sorobanrpc.com',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
        networkName: 'public',
    },
};

interface StepResult {
    name: string;
    status: 'passed' | 'failed';
    txHash?: string;
    detail?: string;
    error?: string;
    durationMs: number;
}

interface SmokeResult {
    network: string;
    contractId: string;
    issuer: string;
    student: string;
    credentialHash: string;
    ipfsUri: string;
    tokenId: string | null;
    issueTxHash: string | null;
    revokeTxHash: string | null;
    status: 'passed' | 'failed';
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
    steps: StepResult[];
}

function nowIso(): string {
    return new Date().toISOString();
}

function elapsedMs(start: [number, number]): number {
    const end = process.hrtime(start);
    return end[0] * 1000 + end[1] / 1e6;
}

// Minimal --key value / --key=value argument parser. Environment variables of
// the form CERTCHAIN_<KEY> act as defaults; CLI arguments always win.
function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const equals = arg.indexOf('=');
        if (equals !== -1) {
            args[arg.slice(2, equals)] = arg.slice(equals + 1);
            continue;
        }
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            args[key] = next;
            i += 1;
        } else {
            args[key] = 'true';
        }
    }
    return args;
}

function envOr(key: string, fallback: string): string {
    return process.env[`CERTCHAIN_${key}`] ?? fallback;
}

function required(name: string, value: string | undefined): string {
    if (!value) {
        throw new Error(
            `Missing required ${name}. Set CERTCHAIN_${name.toUpperCase()} or pass --${name}.`,
        );
    }
    return value;
}

function toU64ScVal(tokenId: string | number): xdr.ScVal {
    return nativeToScVal(BigInt(tokenId), { type: 'u64' });
}

function normalizeTokenId(returnValue: unknown): string | null {
    if (returnValue === null || returnValue === undefined) return null;
    if (typeof returnValue === 'bigint') return returnValue.toString();
    if (typeof returnValue === 'number' && Number.isSafeInteger(returnValue) && returnValue >= 0) {
        return String(returnValue);
    }
    if (typeof returnValue === 'string' && /^\d+$/.test(returnValue)) {
        return returnValue;
    }
    return null;
}

// Read-only simulation of a contract query. No signing, no submission.
async function simulateRead(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourceAddress: string,
    server: rpc.Server,
    networkPassphrase: string,
): Promise<unknown> {
    const contract = new Contract(contractId);
    const source = new Account(sourceAddress, '0');
    const tx = new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase,
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(TimeoutInfinite)
        .build();

    let sim: unknown;
    try {
        sim = await server.simulateTransaction(tx as never);
    } catch (error) {
        throw new Error(
            `RPC error during simulation of ${method}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }

    const simResult = sim as { error?: unknown; result?: { retval?: unknown } };
    if ('error' in simResult && simResult.error) {
        throw new Error(`Simulation error (${method}): ${String(simResult.error)}`);
    }

    const retval = simResult.result?.retval;
    if (retval === undefined || retval === null) return null;
    if (typeof retval === 'string') {
        return scValToNative(xdr.ScVal.fromXDR(retval, 'base64'));
    }
    return scValToNative(retval as xdr.ScVal);
}

function normalizeOnChainCredential(result: unknown): {
    tokenId: string | null;
    student: string;
    issuer: string;
    hash: string;
    uri: string;
    revoked: boolean | null;
} | null {
    if (!result || typeof result !== 'object') return null;

    let record: Record<string, unknown>;
    if (result instanceof Map) {
        record = Object.fromEntries(
            Array.from(result.entries()).map(([key, item]) => [String(key), item]),
        );
    } else {
        record = result as Record<string, unknown>;
    }

    const firstPresent = (keys: string[]): unknown => {
        for (const key of keys) {
            if (record[key] !== undefined && record[key] !== null) return record[key];
        }
        return undefined;
    };

    const tokenId = firstPresent(['token_id', 'tokenId']);
    const revoked = firstPresent(['revoked']);
    const credentialHash = firstPresent(['credential_hash', 'credentialHash', 'hash']);
    const ipfsHash = firstPresent(['ipfs_hash', 'ipfsHash', 'uri']);

    if (!credentialHash || !ipfsHash) return null;

    let hash: string;
    try {
        hash = normalizeCredentialHashHex(String(credentialHash));
    } catch {
        hash = String(credentialHash);
    }

    return {
        tokenId: normalizeTokenId(tokenId),
        student: String(firstPresent(['student']) ?? ''),
        issuer: String(firstPresent(['issuer']) ?? ''),
        hash,
        uri: String(ipfsHash),
        revoked: revoked === true ? true : revoked === false ? false : null,
    };
}

async function waitForConfirmation(
    hash: string,
    server: rpc.Server,
    maxAttempts = 20,
): Promise<{ returnValue: unknown }> {
    for (let i = 0; i < maxAttempts; i += 1) {
        await new Promise((res) => setTimeout(res, 1500));
        const response = await server.getTransaction(hash);
        if (response.status === 'SUCCESS') {
            const returnValue = (response as { returnValue?: unknown }).returnValue;
            let decoded: unknown = null;
            if (returnValue) {
                try {
                    if (typeof returnValue === 'string') {
                        decoded = scValToNative(xdr.ScVal.fromXDR(returnValue, 'base64'));
                    } else {
                        decoded = scValToNative(returnValue as xdr.ScVal);
                    }
                } catch {
                    decoded = null;
                }
            }
            return { returnValue: decoded };
        }
        if (response.status === 'FAILED') {
            throw new Error(
                `Transaction ${hash} failed on-chain.${(response as { resultXdr?: unknown }).resultXdr ? ` ResultXdr: ${String((response as { resultXdr?: unknown }).resultXdr)}` : ''}`,
            );
        }
    }
    throw new Error(`Transaction ${hash} not confirmed after ${maxAttempts} attempts`);
}

interface Signer {
    readonly address: string;
    signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

async function invokeContractMethod(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signer: Signer,
    server: rpc.Server,
    networkPassphrase: string,
): Promise<{ transactionHash: string; returnValue: unknown }> {
    const signerAddress = signer.address;
    const contract = new Contract(contractId);
    const sourceAccount = await server.getAccount(signerAddress);

    const txBuilder = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase,
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(300);
    const transaction = txBuilder.build();

    const simResult = await server.simulateTransaction(transaction as never);
    const sim = simResult as { error?: unknown };
    if ('error' in sim && sim.error) {
        throw new Error(`Simulation failed for ${method}: ${String(sim.error)}`);
    }

    const preparedTx = await server.prepareTransaction(transaction as never);
    const finalXdr = await signer.signTransaction(preparedTx.toXDR(), {
        networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(finalXdr, networkPassphrase);

    const sendResponse = await server.sendTransaction(signedTx as never);
    const send = sendResponse as { status: string; hash: string; errorResult?: unknown };
    if (send.status === 'ERROR') {
        throw new Error(
            `Submission failed for ${method}: ${
                send.errorResult && typeof (send.errorResult as { toXDR: unknown }).toXDR === 'function'
                    ? (send.errorResult as { toXDR: (fmt: string) => string }).toXDR('base64')
                    : 'Unknown error'
            }`,
        );
    }

    const confirmation = await waitForConfirmation(send.hash, server);
    return { transactionHash: send.hash, returnValue: confirmation.returnValue };
}

function printSummary(result: SmokeResult): void {
    const lines: string[] = [];
    lines.push('');
    lines.push('=== CertChain credential lifecycle smoke test ===');
    lines.push(`Network : ${result.network}`);
    lines.push(`Contract: ${result.contractId}`);
    lines.push(`Issuer  : ${result.issuer}`);
    lines.push(`Student : ${result.student}`);
    lines.push(`Hash    : ${result.credentialHash}`);
    lines.push(`URI     : ${result.ipfsUri}`);
    lines.push(`Token   : ${result.tokenId ?? '(n/a)'}`);
    for (const step of result.steps) {
        const mark = step.status === 'passed' ? '✅' : '❌';
        const tx = step.txHash ? ` (tx: ${step.txHash})` : '';
        const detail = step.detail ? ` — ${step.detail}` : '';
        lines.push(
            `[${step.name}] ${mark} ${step.status}${tx}${detail}`,
        );
    }
    if (result.error) {
        lines.push(`ERROR   : ${result.error}`);
    }
    lines.push(`RESULT  : ${result.status.toUpperCase()}`);
    lines.push(`Result file written.`);
    lines.push('');
    console.log(lines.join('\n'));
}

async function run(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const network = (args.network || envOr('NETWORK', 'testnet')).toLowerCase();
    if (!NETWORKS[network]) {
        throw new Error(
            `Unknown network "${network}". Expected one of: ${Object.keys(NETWORKS).join(', ')}.`,
        );
    }
    const netCfg = {
        ...NETWORKS[network],
        ...(args.rpcUrl ? { rpcUrl: args.rpcUrl } : {}),
        ...(args.networkPassphrase ? { networkPassphrase: args.networkPassphrase } : {}),
    };

    const contractId = required('contractId', args.contractId);
    if (!StrKey.isValidContract(contractId)) {
        throw new Error(`Invalid contract ID: ${contractId}`);
    }

    const issuerSecretKey = required('issuerSecretKey', args.issuerSecretKey);
    let issuerKeypair: Keypair;
    try {
        issuerKeypair = Keypair.fromSecret(issuerSecretKey);
    } catch (error) {
        throw new Error(
            `Invalid issuer secret key: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const issuer = issuerKeypair.publicKey();
    if (!StrKey.isValidEd25519PublicKey(issuer)) {
        throw new Error(`Derived issuer address is not a valid Stellar public key: ${issuer}`);
    }

    const student = required('studentAddress', args.studentAddress);
    if (!StrKey.isValidEd25519PublicKey(student)) {
        throw new Error(`Invalid student address: ${student}`);
    }

    const credentialHash = normalizeCredentialHashHex(
        required('credentialHash', args.credentialHash),
    );

    const ipfsUri = args.ipfsUri || envOr('IPFS_URI', `ipfs://smoke-test-${Date.now()}`);
    const resultsFile = args.resultsFile || envOr('RESULTS_FILE', `smoke-test-results-${network}.json`);

    const result: SmokeResult = {
        network,
        contractId,
        issuer,
        student,
        credentialHash,
        ipfsUri,
        tokenId: null,
        issueTxHash: null,
        revokeTxHash: null,
        status: 'failed',
        error: null,
        startedAt: nowIso(),
        finishedAt: null,
        steps: [],
    };

    const server = new rpc.Server(netCfg.rpcUrl);
    const signer: Signer = createKeypairSigner(issuerKeypair);
    const hashScVal = credentialHashHexToScVal(credentialHash);
    const studentScVal = new Address(student).toScVal();
    const issuerScVal = new Address(issuer).toScVal();
    const ipfsScVal = nativeToScVal(ipfsUri, { type: 'string' });

    try {
        // ── Step 1: issue ──
        const issueStart = process.hrtime();
    let issueResult: { transactionHash: string; returnValue: unknown };
    try {
        issueResult = await invokeContractMethod(
            contractId,
            'issue_credential',
            [studentScVal, issuerScVal, hashScVal, ipfsScVal],
            signer,
            server,
            netCfg.networkPassphrase,
        );
    } catch (error) {
        result.steps.push({
            name: 'issue_credential',
            status: 'failed',
            txHash: undefined,
            error: error instanceof Error ? error.message : String(error),
            durationMs: elapsedMs(issueStart),
        });
        throw error;
    }
    const tokenId = normalizeTokenId(issueResult.returnValue);
    if (!tokenId) {
        throw new Error(
            'issue_credential confirmed but did not return a valid token ID',
        );
    }
    result.tokenId = tokenId;
    result.issueTxHash = issueResult.transactionHash;
    result.steps.push({
        name: 'issue_credential',
        status: 'passed',
        txHash: issueResult.transactionHash,
        detail: `token_id=${tokenId}`,
        durationMs: elapsedMs(issueStart),
    });

    // ── Step 2: verify (read-only) ──
    const verifyStart = process.hrtime();
    let verified: { tokenId: string | null; revoked: boolean | null } | null;
    try {
        const raw = await simulateRead(
            contractId,
            'verify_credential',
            [hashScVal],
            issuer,
            server,
            netCfg.networkPassphrase,
        );
        verified = normalizeOnChainCredential(raw);
        if (!verified) {
            throw new Error('verify_credential returned no credential for the issued hash');
        }
        if (verified.tokenId && verified.tokenId !== result.tokenId) {
            throw new Error(
                `verify_credential token_id mismatch: expected ${result.tokenId}, got ${verified.tokenId}`,
            );
        }
        if (verified.revoked === true) {
            throw new Error('verify_credential reports the credential as already revoked');
        }
    } catch (error) {
        result.steps.push({
            name: 'verify_credential',
            status: 'failed',
            txHash: undefined,
            error: error instanceof Error ? error.message : String(error),
            durationMs: elapsedMs(verifyStart),
        });
        throw error;
    }
    result.steps.push({
        name: 'verify_credential',
        status: 'passed',
        txHash: undefined,
        detail: `token_id=${verified.tokenId ?? result.tokenId}, revoked=${verified.revoked}`,
        durationMs: elapsedMs(verifyStart),
    });

    // ── Step 3: revoke ──
    const revokeStart = process.hrtime();
    try {
        const revokeResult = await invokeContractMethod(
            contractId,
            'revoke_credential',
            [toU64ScVal(result.tokenId!), issuerScVal],
            signer,
            server,
            netCfg.networkPassphrase,
        );
        result.revokeTxHash = revokeResult.transactionHash;
        result.steps.push({
            name: 'revoke_credential',
            status: 'passed',
            txHash: revokeResult.transactionHash,
            detail: `token_id=${result.tokenId}`,
            durationMs: elapsedMs(revokeStart),
        });
    } catch (error) {
        result.steps.push({
            name: 'revoke_credential',
            status: 'failed',
            txHash: undefined,
            error: error instanceof Error ? error.message : String(error),
            durationMs: elapsedMs(revokeStart),
        });
        throw error;
    }

    result.status = 'passed';
    } catch (error) {
        result.status = 'failed';
        result.error = error instanceof Error ? error.message : String(error);
    } finally {
        result.finishedAt = nowIso();
        try {
            const fs = await import('fs');
            fs.writeFileSync(resultsFile, JSON.stringify(result, null, 2) + '\n');
        } catch (writeError) {
            // eslint-disable-next-line no-console
            console.error(
                `Failed to write results file ${resultsFile}: ${
                    writeError instanceof Error ? writeError.message : String(writeError)
                }`,
            );
        }
        printSummary(result);
        if (result.status === 'failed') {
            process.exitCode = 1;
        }
    }
}

run().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
