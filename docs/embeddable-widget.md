# Embeddable verification widget

Partners can drop the widget onto any page with a single `<script>` tag and
verify an Acredia credential against the live public API.

## Quickstart

```html
<div id="acredia-verify-widget"
     data-token="CRED_TOKEN"
     data-api="https://acredia-stellar.vercel.app"></div>
<script src="https://acredia-stellar.vercel.app/widget.js" defer></script>
```

The widget is served from `frontend/public/widget.js` and is cache-busted via a
semver `VERSION` embedded in the file (currently `1.0.0`). Pin the version by
referencing a tagged release URL in production.

## Attributes

| Attribute       | Default                  | Meaning                                             |
| --------------- | ------------------------ | --------------------------------------------------- |
| `data-token`    | —                        | Credential token to verify. Required in `inline` mode. |
| `data-api`      | script origin            | Origin of the Acredia API.                          |
| `data-mode`     | `inline`                 | `inline` renders a result card; `popup` opens the full `/verify/<token>` page. |
| `data-api-key`  | —                        | Optional API key; raises the per-key rate limit.    |

## Rendered states

The widget maps backend responses to five user-facing states:

| State              | Trigger                                   |
| ------------------ | ----------------------------------------- |
| `verified`         | `verification.verified === true`          |
| `revoked`          | `verification.revoked === true`           |
| `mismatch`         | On-chain record exists but checks fail    |
| `notfound`         | `404` from the API                        |
| `rateLimited`      | `429` from the API                        |
| `unavailable`      | `503`, or network failure                 |

Rate-limit and chain-unavailable responses degrade to a short retry prompt
rather than a scary error, per issue #87.

## Cross-origin / CORS

`GET /api/verify/:token` and its `OPTIONS` preflight return
`Access-Control-Allow-Origin: *`. The response is a public verification payload
and carries no secrets or cookies, so an open policy is the correct posture —
and because the origin is a wildcard, browsers will refuse to attach cookies
even if a partner tried to send them.

## Content Security Policy

Partners embedding the widget need to allow the Acredia origin in two CSP
directives:

```
script-src  'self' https://acredia-stellar.vercel.app
connect-src 'self' https://acredia-stellar.vercel.app
```

The widget also sets inline `style` attributes on the DOM nodes it creates. If
the partner site disallows `'unsafe-inline'` for `style-src`, host a copy of
`widget.js` with the inline styles rewritten against your own stylesheet; the
rendering logic does not touch any document-global styles.

## Local demo

`frontend/public/widget-demo.html` is a self-contained page that mounts the
widget against the local API. Run `npm run dev` in `frontend/` and visit
`http://localhost:3000/widget-demo.html` to try it with a real credential token.

## Versioning

- The current embed script is `widget.js@1.0.0`.
- Breaking changes bump the major version; new optional attributes bump the
  minor; bug fixes bump the patch.
- When cutting a new major, publish `/widget-v2.js` alongside the old file for
  at least one release cycle so partners can migrate without downtime.
