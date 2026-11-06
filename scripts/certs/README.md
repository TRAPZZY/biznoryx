# Public database TLS trust anchor

`isrg-root-x1.pem` is the unmodified public, self-signed ISRG Root X1 certificate from [Let’s Encrypt](https://letsencrypt.org/certificates/) at [the official PEM URL](https://letsencrypt.org/certs/isrgrootx1.pem), retrieved November 2, 2026. It is not a private key or signing credential.

SHA-256 of DER: `96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6`.

[Northflank’s database access documentation](https://northflank.com/docs/v1/application/databases-and-persistence/access-a-database#access-tls-certificates-in-containers) identifies ISRG Root X1 for addon TLS. The official `postgres:18` image tested here has no general CA store installed; the maintenance generator therefore embeds this pinned public root and supplies a temporary trust file. It keeps `verify-full` and hostname verification. No packages are downloaded by the production job.

Verify the actual provider chain during the private preflight. Stop on a trust/hostname error; do not disable TLS verification. If the provider changes its root, review the current official documentation and approve a replacement trust anchor rather than silently trusting arbitrary server certificates.
