# Email Configuration

CertChain sends transactional email for:
- Institution invite links
- Student invite links
- Password reset
- Credential issuance notifications (optional)
- Credential revocation notifications (optional)

---

## Why Custom SMTP Is Required

Supabase's built-in mailer is capped at **~3 emails per hour**. This is sufficient for local
development but will fail in production as soon as an institution provisions more than a few
students in a short window.

---

## Zero-Cost Setup (Gmail SMTP)

Suitable for low-volume deployments (< 500 emails/day).

1. Create a Google account dedicated to this project (e.g. `certchain.noreply@gmail.com`).
2. Enable 2-factor authentication on the account.
3. Generate an [App Password](https://myaccount.google.com/apppasswords):
   - Google Account → Security → 2-Step Verification → App passwords
   - Select "Mail" and "Other (custom name)" → name it "CertChain"
   - Copy the 16-character password.
4. In Supabase Dashboard → Project Settings → Authentication → SMTP Settings:
   ```
   Host:     smtp.gmail.com
   Port:     587
   Security: STARTTLS
   User:     your-dedicated-address@gmail.com
   Password: (the 16-character App Password)
   Sender:   CertChain <certchain.noreply@gmail.com>
   ```
5. Test by triggering a password reset in the Supabase dashboard.

**Limits:** ~500 emails/day. If you hit this, migrate to a dedicated provider.

---

## Production Setup (Resend / Postmark / SendGrid)

For higher volumes or when SPF/DKIM/DMARC alignment is required (common for university
email filters).

### Resend (recommended for simplicity)

1. Sign up at https://resend.com — free tier includes 3,000 emails/month.
2. Add and verify your sending domain (requires DNS access).
3. Generate an API key.
4. Set in `frontend/.env.local`:
   ```bash
   RESEND_API_KEY=re_your_api_key
   ```
5. Update the Supabase SMTP settings to use Resend's SMTP relay, or use the Resend API
   directly via `frontend/src/lib/email.ts`.

### Upgrade triggers

Migrate from Gmail to a dedicated provider when:
- Daily volume exceeds 300 emails
- SPF/DKIM/DMARC alignment is required (most university domains)
- You need delivery receipts or bounce handling

---

## Direct Recovery Links (Fallback)

If email delivery is broken (e.g. SMTP misconfigured), admins can generate direct invite links
from the admin dashboard:

1. Go to Admin Dashboard → Institutions → select institution.
2. Click "Regenerate invite link".
3. Copy and send the link directly to the POC.

These links expire after 24 hours and are single-use.

---

## Email Templates

All email templates live in `frontend/src/lib/emailTemplates.ts`. They are plain TypeScript
strings with simple `{{variable}}` placeholders — no templating engine dependency.

To preview a template locally, run:
```bash
cd frontend
npm run email-worker -- --preview invite
```
