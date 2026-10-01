import { debugLog, captureException } from './debug';
import { getE2eState } from './e2e';
import { runtimeConfig } from './runtimeConfig';
import { supabase, safeGetSession } from './supabase';

const PINATA_GATEWAY = runtimeConfig.ipfs.gatewayUrl;
const IPFS_FILE_ROUTE = '/api/ipfs/file';
const IPFS_JSON_ROUTE = '/api/ipfs/json';

const EXPIRED_TOKEN_ERROR = 'Invalid or expired access token';
const SIGNED_OUT_MESSAGE = 'You must be signed in as an institution to upload to IPFS.';

async function getAccessToken(): Promise<string> {
    const { data } = await safeGetSession();
    const accessToken = data.session?.access_token;

    if (!accessToken) {
        throw new Error(SIGNED_OUT_MESSAGE);
    }

    return accessToken;
}

/**
 * POST to a server IPFS route with the caller's Supabase access token. The
 * routes reject anonymous and non-institution callers, so the token is
 * mandatory; a single retry covers a token that expired mid-flight.
 */
async function postToIpfsRoute(
    route: string,
    buildRequest: (accessToken: string) => RequestInit,
): Promise<Response> {
    const accessToken = await getAccessToken();
    const response = await fetch(route, buildRequest(accessToken));

    if (response.status !== 401) {
        return response;
    }

    const payload = await response.clone().json().catch(() => null);
    if (payload?.error !== EXPIRED_TOKEN_ERROR) {
        return response;
    }

    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    const newAccessToken = refreshed.session?.access_token;

    if (refreshError || !newAccessToken) {
        throw new Error('Your session expired. Please sign in again.');
    }

    return fetch(route, buildRequest(newAccessToken));
}

export async function uploadToIPFS(file: File): Promise<string> {
    if (getE2eState()?.enabled) {
        return `e2e-file-${file.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    }

    try {
        const response = await postToIpfsRoute(IPFS_FILE_ROUTE, (accessToken) => {
            // Rebuilt per attempt: a FormData body is consumed by the first fetch.
            const formData = new FormData();
            formData.append('file', file, file.name);

            return {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
                body: formData,
            };
        });

        const payload = await response.json();

        if (!response.ok || !payload?.cid) {
            throw new Error(payload?.error || 'IPFS upload failed');
        }

        const cid = payload.cid as string;
        debugLog('File uploaded to IPFS via server IPFS route.');
        return cid;
    } catch (error: unknown) {
        captureException(error, { context: 'uploadToIPFS' });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to upload to IPFS: ${message}`, { cause: error });
    }
}
export async function uploadJSONToIPFS(data: unknown): Promise<string> {
    if (getE2eState()?.enabled) {
        return 'e2e-metadata-cid';
    }

    try {
        const response = await postToIpfsRoute(IPFS_JSON_ROUTE, (accessToken) => ({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ content: data }),
        }));

        const payload = await response.json();

        if (!response.ok || !payload?.cid) {
            throw new Error(payload?.error || 'IPFS JSON upload failed');
        }

        const cid = payload.cid as string;
        debugLog('JSON uploaded to IPFS via server IPFS route.');
        return cid;
    } catch (error: unknown) {
        captureException(error, { context: 'uploadJSONToIPFS' });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to upload JSON to IPFS: ${message}`, { cause: error });
    }
}

export function getIPFSUrl(cidOrUri: string): string {
    if (!cidOrUri || cidOrUri.trim() === '') {
        return '#';
    }

    const fullPath = cidOrUri.replace('ipfs://', '');
    const parts = fullPath.split('/');
    const cid = parts[0];
    const path = parts.length > 1 ? '/' + parts.slice(1).join('/') : '';

    if (!cid || cid === 'undefined' || cid === 'null') {
        return '#';
    }

    return `${PINATA_GATEWAY}/ipfs/${cid}${path}`;
}
export async function fetchFromIPFS(cid: string): Promise<unknown> {
    try {
        const url = getIPFSUrl(cid);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch from IPFS: ${response.statusText}`);
        }

        return await response.json();
    } catch (error: unknown) {
        captureException(error, { context: 'fetchFromIPFS' });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to fetch from IPFS: ${message}`, { cause: error });
    }
}
