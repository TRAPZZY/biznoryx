# Verification email deliverability

## Evidence collected on 14 October 2026

- Northflank production API `biznoryx` runs main revision
  `3ddb3359b4b0d473afe7acd9cc69ed3e058e17ee` at investigation time.
- Its configured sender is `BIZNORYX <verify@biznoryx.com>`.
- The production sender calls Resend's HTTPS `/emails` API and provides both
  HTML and plain text. Subject: `Your BIZNORYX verification code`.
  Password recovery uses `Reset your BIZNORYX password`.
- No Reply-To is configured. Do not invent an unmonitored support mailbox.
- Both versions contain the same code and expiration instruction. They contain
  no links, redirects, external images, attachments or promotional material.
  Resend's domain-level open/click tracking still needs dashboard verification;
  absence of a tracking image in source does not prove provider tracking is off.
- Public DNS queried through Cloudflare: DMARC is `v=DMARC1; p=none;`;
  `resend._domainkey.biznoryx.com` publishes a DKIM public key;
  `send.biznoryx.com` is a CNAME to `send.forge.rmta.net` and
  `rsend.biznoryx.com` is a CNAME to `rsend.forge.rmta.net`.
- The `send` CNAME target publishes one SPF record:
  `v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all`,
  and an MX pointing to `feedback.forge.rmta.net` with priority 10.
  No apex TXT SPF record was returned. This alone is not a defect: SPF evaluates
  the actual SMTP envelope domain, not necessarily the visible From domain.
- The user reports verified Resend domain/DKIM/sending records and delivered
  messages that sometimes land in Gmail spam. Received-message authentication,
  sending reputation, bounce/complaint/suppression metrics and inbox placement
  have not been independently verified. Do not treat DELIVERED as inbox proof.

## Application correction

An isolated regression reproduced a Resend transport exception becoming an
unhandled application error/HTTP 500 during registration. The sender now converts
transport rejection into the existing sanitized `EmailDeliveryError`. The
repository invalidates the undelivered challenge and returns
`EMAIL_DELIVERY_FAILED`/HTTP 503 for browser and native registration/resend.

Sender, subject, template, challenge hashing, ten-minute expiry, five-attempt
limit, rate limits, idempotency key, session handling and CSRF are unchanged.
There is no retry that could duplicate messages. No migration or new secret is
required. This resilience correction is not a demonstrated fix for spam-folder
placement of successfully delivered messages.

## Received-message checks

Use a consenting isolated Gmail/Outlook inbox, never a customer's account.
Request a verification email through normal registration/resend; do not record
its code, password, recipient or message body in logs, screenshots or tickets.
Record only the provider delivery event and destination folder, and these
redacted header facts from Gmail Show original / Outlook message details:

- SPF result and `smtp.mailfrom` domain, including the sending IP used for SPF.
- DKIM result, `header.d` domain and `header.s` selector.
- DMARC result and `header.from` domain.
- Return-Path domain, forwarding status and provider-side tracking settings.

For the current From domain, DKIM signing with `d=biznoryx.com` aligns. An
envelope domain such as `send.biznoryx.com` aligns under the current default
relaxed DMARC policy. These are expected relationships, not observed passes.
If authentication fails, investigate the exact header identity/selector/IP
before touching DNS. If it passes, investigate reputation, complaints, abusive
registration traffic and provider delivery insights instead of guessing.

## Conservative provider and DNS actions

Inspect Resend's domain configuration, Insights, delivery/bounce/complaint events
and suppression list without opening code-bearing email content. Keep existing
SPF, DKIM, DMARC, MX, CNAME, A/ALIAS records. Do not add TXT records at existing
CNAME names or a second SPF record at any hostname. Keep `p=none` during this
investigation. A stricter DMARC policy is not a spam-placement remedy.

Resend recommends separate sending subdomains for reputation segmentation.
`mail.biznoryx.com` is a reasonable future transactional identity, not an
immediate remedy or a guaranteed inbox improvement. Before any migration:

1. Add `mail.biznoryx.com` in Resend, leaving `biznoryx.com` enabled.
2. Export the exact provider-generated DNS record type/name/value/TTL/priority
   from that domain's setup. Values depend on the provider/region; do not copy
   the root domain's key or guess MX, SPF, DKIM or CNAME destinations.
3. Review the generated records and Hostinger conflicts, then add only the
   approved new records. Verify sending in Resend before changing the From.
4. Check open/click tracking is disabled for transactional codes. Verify an
   isolated test message's authentication and destination folder.
5. Only then approve changing the sender to `BIZNORYX <verify@mail.biznoryx.com>`.
   Preserve the old identity for rollback. Monitor both identities during rollout.

Provider documentation:
- https://resend.com/docs/knowledge-base/how-do-i-avoid-gmails-spam-folder
- https://resend.com/docs/knowledge-base/is-it-better-to-send-emails-from-a-subdomain-or-the-root-domain
- https://resend.com/docs/api-reference/domains/update-domain
- https://support.google.com/mail/answer/81126
- https://support.google.com/mail/answer/180707

## Deployment and rollback

Run the focused email sender/repository and native/browser authentication tests,
then require the existing clean GitHub Actions acceptance workflow and normal PR
review. Generated untracked Android build JSON in the shared checkout is not
part of this patch and must not be removed to make the local formatter pass.

Before merging, verify Northflank still runs the expected baseline, its previous
build is retained and a successful recovery backup is available. Use the existing
main-branch continuous deployment; do not trigger duplicate restarts, migrate
schemas or alter worker, billing, DNS or secrets. Verify the deployed SHA,
`/healthz` and `/readyz`; inspect only redacted delivery-error log evidence.
Roll back to the retained previous build if a critical regression appears.
