# Generate printable PDF certificates with an IPFS pin (#92)

## Summary

Credential metadata had no printable representation. This adds a dependency-free PDF renderer, a download route that
pins the generated PDF to IPFS, and a download action in the student share view. The PDF CID is an additional artifact
and is deliberately excluded from the canonical credential hash, so existing hashes stay unchanged.

## What changed

- **`frontend/src/lib/pdfCertificate.ts`** (new) — builds a valid single-page PDF 1.4 with Helvetica text from public
  credential fields; escapes PDF text and avoids browser-only APIs.
- **`frontend/src/app/api/credentials/[token]/pdf/route.ts`** (new) — rate-limited route that loads the credential,
  renders the PDF, pins it via `pinFileToPinata`, and returns it with `application/pdf`, an attachment filename and the
  `X-IPFS-CID` header.
- **`frontend/src/components/student/QRCodeModal.tsx`** — added a "PDF certificate" download link; existing QR download
  button relabelled for clarity.
- **`frontend/tests/pdfCertificate.test.ts`** — validates PDF structure, credential fields and escaping.

## Acceptance criteria addressed

- Generated PDFs reflect credential fields and are downloadable from the student view.
- The canonical credential hash payload is untouched; the PDF (and its CID) is an additional pin only.

closes #92
