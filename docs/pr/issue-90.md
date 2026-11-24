# Encode SEP-0007 URIs in credential QR codes (#90)

## Summary

The student share modal already rendered a QR code, but it encoded a plain `/verify?token=…` URL that Stellar wallets
could not open as a deep link. The QR now encodes the existing `buildVerificationDeepLink()` SEP-0007 `web+stellar:`
URI, with the plain verification URL retained for copy/share.

## What changed

- **`frontend/src/components/student/QRCodeModal.tsx`** — builds the QR payload via `buildVerificationDeepLink()` using
  the credential token id, app origin and institution name; the dialog explains the wallet-compatible payload.
- **`frontend/tests/sep0007Qr.test.ts`** — verifies the generated URI parses back to the correct verification URL and
  institution message.

## Acceptance criteria addressed

- Credential sharing produces a SEP-0007 QR code that wallets can scan to open verification directly.

closes #90
