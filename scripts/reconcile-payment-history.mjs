import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { verifyPaystackTransaction } from "../src/billing/paystack.mjs";
import {
  PostgresBillingRepository,
  withBillingTenant,
} from "../src/database/billing-repository.mjs";

export async function reconcilePaymentHistory({
  organizationId,
  checkouts,
  verify,
  billing,
  apply = false,
}) {
  const records = [];
  for (const checkout of checkouts) {
    const record = {
      referenceHash: createHash("sha256")
        .update(String(checkout.reference))
        .digest("hex")
        .slice(0, 16),
    };
    try {
      if (
        checkout.organization_id !== organizationId ||
        checkout.provider !== "paystack" ||
        checkout.status !== "completed" ||
        typeof checkout.reference !== "string" ||
        checkout.reference.startsWith("bnx_trial_")
      ) {
        throw new Error("invalid_checkout");
      }
      const verified = await verify(checkout.reference);
      if (verified?.domain !== "live") {
        record.result = "not_verified_live";
        records.push(record);
        continue;
      }
      let metadata = verified.metadata;
      if (typeof metadata === "string") {
        try {
          metadata = JSON.parse(metadata);
        } catch {
          throw new Error("invalid_metadata");
        }
      }
      const paidAtValue = verified.paid_at ?? verified.transaction_date;
      const paidAt = paidAtValue ? new Date(paidAtValue) : new Date(NaN);
      if (
        verified.status !== "success" ||
        verified.reference !== checkout.reference ||
        !Number.isSafeInteger(Number(verified.amount)) ||
        Number(verified.amount) <= 0 ||
        Number(verified.amount) !== Number(checkout.amount_minor) ||
        verified.currency !== checkout.currency ||
        !Number.isFinite(paidAt.getTime()) ||
        (metadata?.organization_id &&
          metadata.organization_id !== organizationId) ||
        (metadata?.organizationId && metadata.organizationId !== organizationId)
      ) {
        throw new Error("payment_mismatch");
      }
      if (apply) {
        const saved = await billing.recordPayment({
          organizationId,
          provider: "paystack",
          reference: verified.reference,
          status: "success",
          amountMinor: Number(verified.amount),
          currency: verified.currency,
          channel: verified.channel ?? null,
          paidAt,
        });
        if (
          saved.reference !== verified.reference ||
          Number(saved.amountMinor) !== Number(verified.amount) ||
          saved.currency !== verified.currency ||
          new Date(saved.paidAt).getTime() !== paidAt.getTime()
        )
          throw new Error("existing_record_conflict");
      }
      record.result = apply
        ? "recorded_or_already_present"
        : "verified_live_dry_run";
    } catch (error) {
      const reasons = [
        "invalid_checkout",
        "invalid_metadata",
        "payment_mismatch",
        "existing_record_conflict",
      ];
      record.result = reasons.includes(error.message)
        ? error.message
        : "verification_or_storage_failed";
    }
    records.push(record);
  }
  return { apply, checked: records.length, records };
}

async function main() {
  const args = process.argv.slice(2);
  let organizationId,
    limit = 25,
    apply = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--organization-id") organizationId = args[++index];
    else if (args[index] === "--limit") limit = Number(args[++index]);
    else if (args[index] === "--apply") apply = true;
    else
      throw new Error("Use --organization-id UUID [--limit 1..100] [--apply].");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      organizationId ?? "",
    ) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("A valid organization UUID and limit 1..100 are required.");
  if (
    !process.env.DATABASE_URL ||
    !/^(sk|rk)_live_/.test(String(process.env.PAYSTACK_SECRET_KEY ?? "").trim())
  ) {
    throw new Error(
      "An existing private database connection and live Paystack key are required.",
    );
  }
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10000,
    options: "-c statement_timeout=15000 -c lock_timeout=2000",
  });
  try {
    const checkouts = await withBillingTenant(
      pool,
      { organizationId },
      async (client) =>
        (
          await client.query(
            `select organization_id, provider, reference, status, amount_minor, currency
         from billing_checkout_sessions where organization_id=$1 and provider='paystack' and status='completed'
           and reference !~ '^bnx_trial_'
         order by completed_at desc, id desc limit $2`,
            [organizationId, limit],
          )
        ).rows,
    );
    const result = await reconcilePaymentHistory({
      organizationId,
      checkouts,
      verify: (reference) => verifyPaystackTransaction({ reference }),
      billing: new PostgresBillingRepository(pool),
      apply,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (
      result.records.some(
        (record) =>
          ![
            "recorded_or_already_present",
            "verified_live_dry_run",
            "not_verified_live",
          ].includes(record.result),
      )
    ) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write(
      "Payment history reconciliation stopped. Check private connection access and input; no credentials were logged.\n",
    );
    process.exitCode = 1;
  });
}
