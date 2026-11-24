/*! Acredia Verification Widget v1.0.0
 *
 * Partner embed:
 *   <div id="acredia-verify-widget" data-token="CRED_TOKEN"
 *        data-api="https://acredia-stellar.vercel.app"></div>
 *   <script src="https://acredia-stellar.vercel.app/widget.js" defer></script>
 *
 * Attributes:
 *   data-token   (required) the credential token to verify
 *   data-api     (optional) API origin; defaults to the origin of this script's src
 *   data-mode    (optional) "inline" (default) | "popup" (legacy, opens /verify/<token>)
 *   data-api-key (optional) opt-in bearer-style key, raises the per-key rate-limit
 *
 * CSP guidance for the embedding site:
 *   script-src  'self' https://acredia-stellar.vercel.app
 *   connect-src 'self' https://acredia-stellar.vercel.app
 *   style-src   'self' 'unsafe-inline'  (the widget sets inline styles on its nodes)
 *
 * Partners who disallow 'unsafe-inline' for styles can instead host a copy of
 * this script and strip the inline styles — the widget never touches document
 * global styles and only renders inside its own container.
 */
(function () {
    'use strict';

    var VERSION = '1.0.0';
    var CONTAINER_ID = 'acredia-verify-widget';

    function getScriptOrigin() {
        var scripts = document.getElementsByTagName('script');
        for (var i = 0; i < scripts.length; i++) {
            var src = scripts[i].src || '';
            if (src.indexOf('widget.js') !== -1) {
                try { return new URL(src).origin; } catch (_e) { /* ignore */ }
            }
        }
        return 'https://acredia-stellar.vercel.app';
    }

    function el(tag, style, text) {
        var node = document.createElement(tag);
        if (style) {
            for (var k in style) {
                if (Object.prototype.hasOwnProperty.call(style, k)) {
                    node.style[k] = style[k];
                }
            }
        }
        if (text !== undefined && text !== null) {
            node.textContent = String(text);
        }
        return node;
    }

    var BASE_STYLES = {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontSize: '14px',
        lineHeight: '1.4',
        color: '#111827',
        padding: '12px 14px',
        borderRadius: '8px',
        border: '1px solid #e5e7eb',
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        maxWidth: '420px',
        boxSizing: 'border-box',
    };

    var BADGES = {
        verified:    { bg: '#ecfdf5', fg: '#065f46', label: 'Verified on-chain' },
        revoked:     { bg: '#fef2f2', fg: '#991b1b', label: 'Revoked' },
        mismatch:    { bg: '#fffbeb', fg: '#92400e', label: 'Mismatch — not verified' },
        notfound:    { bg: '#f3f4f6', fg: '#374151', label: 'Credential not found' },
        rateLimited: { bg: '#fffbeb', fg: '#92400e', label: 'Rate limit — try again shortly' },
        unavailable: { bg: '#f3f4f6', fg: '#374151', label: 'Verification temporarily unavailable' },
        error:       { bg: '#fef2f2', fg: '#991b1b', label: 'Verification error' },
        loading:     { bg: '#eff6ff', fg: '#1e3a8a', label: 'Verifying…' },
    };

    function renderShell(container) {
        container.innerHTML = '';
        var root = el('div', BASE_STYLES);
        root.setAttribute('role', 'status');
        root.setAttribute('aria-live', 'polite');
        root.setAttribute('data-acredia-widget-version', VERSION);
        container.appendChild(root);
        return root;
    }

    function renderBadge(state) {
        var style = BADGES[state] || BADGES.error;
        var badge = el('span', {
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: '9999px',
            background: style.bg,
            color: style.fg,
            fontWeight: '600',
            fontSize: '12px',
        }, style.label);
        return badge;
    }

    function renderDetail(root, label, value) {
        if (value === undefined || value === null || value === '') return;
        var row = el('div', { marginTop: '4px', color: '#374151', fontSize: '13px' });
        var k = el('span', { color: '#6b7280' }, label + ': ');
        var v = el('span', null, String(value));
        row.appendChild(k);
        row.appendChild(v);
        root.appendChild(row);
    }

    function pickState(body) {
        // Decide the display state from the API payload. The route returns
        // { verification: { verified, revoked, onChainFound, ... } }.
        if (!body || !body.success) return 'error';
        var v = body.verification || {};
        if (v.revoked) return 'revoked';
        if (v.verified) return 'verified';
        if (!v.onChainFound) return 'notfound';
        return 'mismatch';
    }

    function renderResult(root, body) {
        var state = pickState(body);
        root.innerHTML = '';
        root.appendChild(renderBadge(state));

        var credential = (body && body.credential) || {};
        var head = el('div', { marginTop: '8px', fontWeight: '600' },
            credential.institutionName || 'Acredia credential');
        root.appendChild(head);

        renderDetail(root, 'Credential', credential.credentialType || credential.degree);
        renderDetail(root, 'Token', credential.tokenId);
        renderDetail(root, 'Issued', credential.issueDate || credential.issuedAt);

        var v = (body && body.verification) || {};
        if (v.integrity && v.integrity.status) {
            renderDetail(root, 'Document integrity', v.integrity.status);
        }
        if (state === 'revoked' && v.revocationSource) {
            renderDetail(root, 'Revoked by', v.revocationSource);
        }

        var footer = el('div', {
            marginTop: '10px',
            paddingTop: '8px',
            borderTop: '1px solid #f3f4f6',
            fontSize: '12px',
            color: '#6b7280',
        });
        footer.appendChild(document.createTextNode('Verified via Acredia · '));
        var link = el('a', { color: '#1d4ed8', textDecoration: 'none' },
            'open full report');
        link.href = '';
        footer.appendChild(link);
        root.appendChild(footer);
        return link;
    }

    function renderState(root, state, message) {
        root.innerHTML = '';
        root.appendChild(renderBadge(state));
        if (message) {
            var p = el('div', { marginTop: '6px', color: '#374151' }, message);
            root.appendChild(p);
        }
    }

    function buildEmbedHref(origin, token) {
        return origin + '/verify' + (token ? '/' + encodeURIComponent(token) : '');
    }

    function initOne(container) {
        if (!container || container.getAttribute('data-acredia-initialized') === '1') return;
        container.setAttribute('data-acredia-initialized', '1');

        var token = (container.getAttribute('data-token') || '').trim();
        var apiOrigin = (container.getAttribute('data-api') || '').trim() || getScriptOrigin();
        var mode = (container.getAttribute('data-mode') || 'inline').trim();
        var apiKey = (container.getAttribute('data-api-key') || '').trim();

        if (mode === 'popup' || !token) {
            // Legacy popup behavior / no token → show a button that opens the
            // full verify page on the Acredia site.
            var root = renderShell(container);
            var btn = el('button', {
                background: '#1d4ed8', color: '#ffffff', border: 'none',
                padding: '8px 14px', borderRadius: '6px', cursor: 'pointer',
                fontWeight: '600',
            }, token ? 'Verify with Acredia' : 'Open Acredia');
            btn.type = 'button';
            btn.addEventListener('click', function () {
                window.open(buildEmbedHref(apiOrigin, token), 'AcrediaVerify',
                    'width=600,height=750,resizable=yes,scrollbars=yes');
            });
            root.appendChild(btn);
            return;
        }

        var root2 = renderShell(container);
        renderState(root2, 'loading', 'Checking credential on Stellar…');

        var url = apiOrigin + '/api/verify/' + encodeURIComponent(token);
        var headers = { 'Accept': 'application/json' };
        if (apiKey) headers['x-api-key'] = apiKey;

        // Deliberately `credentials: 'omit'` — the widget never wants cookies
        // sent to the Acredia origin, and a wildcard CORS response wouldn't
        // honour them anyway.
        fetch(url, { method: 'GET', headers: headers, credentials: 'omit', mode: 'cors' })
            .then(function (res) {
                var status = res.status;
                return res.json().catch(function () { return null; }).then(function (body) {
                    return { status: status, body: body };
                });
            })
            .then(function (r) {
                if (r.status === 429) {
                    renderState(root2, 'rateLimited',
                        'Too many verification requests. Please retry in a moment.');
                    return;
                }
                if (r.status === 503) {
                    renderState(root2, 'unavailable',
                        'The Stellar network is temporarily unreachable. Retry shortly.');
                    return;
                }
                if (r.status === 404) {
                    renderState(root2, 'notfound',
                        'No credential with this token was found.');
                    return;
                }
                if (r.status >= 400 || !r.body || !r.body.success) {
                    var msg = (r.body && r.body.error) || 'Unable to verify this credential.';
                    renderState(root2, 'error', msg);
                    return;
                }
                var link = renderResult(root2, r.body);
                if (link) link.href = buildEmbedHref(apiOrigin, token);
            })
            .catch(function () {
                renderState(root2, 'unavailable',
                    'Could not reach the verification service.');
            });
    }

    function initAll() {
        var nodes = document.querySelectorAll('#' + CONTAINER_ID + ', .' + CONTAINER_ID);
        for (var i = 0; i < nodes.length; i++) initOne(nodes[i]);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

    // Expose a tiny programmatic API for SPAs that mount the container late.
    window.AcrediaVerify = window.AcrediaVerify || {
        version: VERSION,
        mount: initOne,
        mountAll: initAll,
    };
})();
