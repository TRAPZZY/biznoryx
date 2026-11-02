import { createHash } from "node:crypto";
import { AuthError, CAPABILITIES, ROLE_CAPABILITIES } from "../auth/core.mjs";
import {
  MoneyTrailError,
  MONEY_TRAIL_LIMITS,
  decimalMoney,
  moneyTrailText,
  normalizeMoneyRecord,
  normalizeClassification,
  moneyTrailPeriod,
  moneyTrailReport,
} from "../reports/money-trail.mjs";
import { withTenantTransaction } from "./postgres.mjs";

/**
 * Integration contract (trusted server context supplies organizationId/actorUserId):
 * available() -> boolean; list(ctx + {period?: 'YYYY-MM'}) -> live report.
 * importRecords(ctx + {ingestionRunId, records, idempotencyKey}) ->
 *   {importId, recordIds, importedCount, existingCount, idempotent, currency}.
 * Each record requires sourceRowLocator pointing into the ORIGINAL source,
 * date, decimal-string amount, kind; optional reference, description,
 * paymentStatus, dueDate, referenceConfirmed. Extraction/mapping is upstream.
 * allocate(ctx + {saleId, receiptId, amount, expectedSaleVersion, expectedReceiptVersion})
 *   -> allocation with saleVersion/receiptVersion. receiptId accepts a reviewed
 * receipt, credit, or refund; a refund reopens only previously paid balances.
 * reverseAllocation(ctx + {allocationId, reason}) -> immutable reversal.
 * classify(ctx + {id, classification, expectedVersion}) -> current record.
 * classification is a full {kind,paymentStatus?,dueDate?,referenceConfirmed?,reason}
 * snapshot. Reverse active allocations before changing classification.
 * Errors use AuthError ORG_ACCESS_DENIED/CAPABILITY_DENIED, or MoneyTrailError
 * MONEY_TRAIL_{INVALID_INPUT,NOT_FOUND,VERSION_CONFLICT,OVER_ALLOCATION,
 * SOURCE_CONFLICT,SOURCE_REVIEW_REQUIRED,IDEMPOTENCY_CONFLICT,REVERSE_REQUIRED}.
 * No matching or allocation is automatic. Version conflicts require a refresh.
 *
 * Retention integration: child-first tables are reversals, allocations,
 * import_records, classifications, record_states, records, imports. Normal
 * runtime has no DELETE; immutable guards must be handled only by the privileged
 * authorized account-deletion process. Never cascade routine source corrections.
 */
export class PostgresMoneyTrailRepository {
  constructor(pool) {
    if (!pool) throw new TypeError("PostgreSQL pool is required.");
    this.pool = pool;
  }

  async available() {
    const result = await this.pool
      .query(`select to_regclass('public.money_trail_records') is not null
      and to_regclass('public.money_trail_reversals') is not null as available`);
    return result.rows[0].available;
  }

  async transaction(input, write, work) {
    identifier(input.organizationId);
    identifier(input.actorUserId);
    try {
      return await withTenantTransaction(this.pool, input, async (client) => {
        const member = await client.query(
          `select m.role from organization_memberships m
          join organizations o on o.id = m.organization_id and o.disabled_at is null
          join app_users u on u.id = m.user_id and u.disabled_at is null
          where m.organization_id = $1 and m.user_id = $2 and m.status = 'active' and m.disabled_at is null
          for share of m, o, u`,
          [input.organizationId, input.actorUserId],
        );
        if (!member.rows[0])
          throw new AuthError(
            "Active organization membership is required.",
            "ORG_ACCESS_DENIED",
          );
        const capability = write
          ? CAPABILITIES.WRITE_BUSINESS_DATA
          : CAPABILITIES.READ_BUSINESS_DATA;
        if (
          !(ROLE_CAPABILITIES[member.rows[0].role] ?? []).includes(capability)
        )
          throw new AuthError(
            "Business capability is required.",
            "CAPABILITY_DENIED",
          );
        return await work(client);
      });
    } catch (error) {
      if (
        error.code === "23514" &&
        error.message.includes("MONEY_TRAIL_OVER_ALLOCATION")
      )
        throw new MoneyTrailError(
          "Allocation or reversal would exceed a source amount or confirmed balance.",
          "MONEY_TRAIL_OVER_ALLOCATION",
        );
      throw error;
    }
  }

  async importRecords(input) {
    identifier(input.ingestionRunId);
    const idempotencyKey = moneyTrailText(
      input.idempotencyKey,
      "Idempotency key",
      180,
      true,
    );
    if (
      !Array.isArray(input.records) ||
      input.records.length < 1 ||
      input.records.length > MONEY_TRAIL_LIMITS.importRecords
    )
      throw new MoneyTrailError(
        `Import requires 1–${MONEY_TRAIL_LIMITS.importRecords} reviewed records.`,
      );
    const records = input.records
      .map(normalizeMoneyRecord)
      .sort((a, b) =>
        a.sourceRowLocator < b.sourceRowLocator
          ? -1
          : a.sourceRowLocator > b.sourceRowLocator
            ? 1
            : 0,
      );
    if (
      new Set(records.map((record) => record.sourceRowLocator)).size !==
      records.length
    )
      throw new MoneyTrailError(
        "Source row locators must be unique within an import.",
      );
    if (input.supersedesRunId) identifier(input.supersedesRunId);
    const correctionReason = input.supersedesRunId
      ? moneyTrailText(input.correctionReason, "Correction reason", 1000, true)
      : null;
    const contentHash = hash({
      ingestionRunId: input.ingestionRunId,
      records,
      supersedesRunId: input.supersedesRunId ?? null,
      correctionReason,
    });
    return this.transaction(input, true, async (client) => {
      // One organization import lock prevents races between keys, cumulative
      // manual snapshots and corrected full-file imports in the same series.
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`money-trail-import:${input.organizationId}`],
      );
      const prior = await client.query(
        `select id, content_sha256 from money_trail_imports where organization_id = $1 and idempotency_key = $2`,
        [input.organizationId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].content_sha256 !== contentHash)
          throw new MoneyTrailError(
            "Idempotency key was already used for different records.",
            "MONEY_TRAIL_IDEMPOTENCY_CONFLICT",
          );
        const saved = await client.query(
          `select record_id from money_trail_import_records where organization_id = $1 and import_id = $2 order by record_id`,
          [input.organizationId, prior.rows[0].id],
        );
        return {
          importId: prior.rows[0].id,
          recordIds: saved.rows.map((row) => row.record_id),
          importedCount: 0,
          existingCount: saved.rowCount,
          idempotent: true,
          currency: "NGN",
        };
      }
      const source = await client.query(
        `select ir.id, ir.status, ir.data_stream_id, ir.reporting_period_id, ir.raw_data_object_id, r.checksum_sha256
        from ingestion_runs ir join raw_data_objects r on r.id = ir.raw_data_object_id and r.organization_id = ir.organization_id
        where ir.organization_id = $1 and ir.id = $2 for share of ir, r`,
        [input.organizationId, input.ingestionRunId],
      );
      const run = source.rows[0];
      if (!run)
        throw new MoneyTrailError(
          "Ingestion source not found.",
          "MONEY_TRAIL_NOT_FOUND",
        );
      if (run.status !== "validated")
        throw new MoneyTrailError(
          "Source must be validated before importing financial records.",
          "MONEY_TRAIL_SOURCE_REVIEW_REQUIRED",
        );
      const overlap = await client.query(
        `select distinct ir.id from money_trail_imports i
        join ingestion_runs ir on ir.organization_id = i.organization_id and ir.id = i.ingestion_run_id
        where i.organization_id = $1 and ir.data_stream_id = $2 and ir.reporting_period_id = $3
          and ir.raw_data_object_id <> $4 and not exists(select 1 from money_trail_source_supersessions c where c.organization_id=i.organization_id and c.previous_ingestion_run_id=ir.id) limit 2`,
        [
          input.organizationId,
          run.data_stream_id,
          run.reporting_period_id,
          run.raw_data_object_id,
        ],
      );
      if (overlap.rowCount) {
        if (
          overlap.rows.length !== 1 ||
          overlap.rows[0].id !== input.supersedesRunId
        )
          throw new MoneyTrailError(
            "This series/period already has financial records. Explicitly name the prior source and a correction reason; it cannot add a second sale set.",
            "MONEY_TRAIL_SOURCE_REVIEW_REQUIRED",
          );
        const heads = await client.query(
          "select id from money_trail_records where organization_id=$1 and ingestion_run_id=$2 order by id",
          [input.organizationId, input.supersedesRunId],
        );
        await lockRecords(
          client,
          input,
          heads.rows.map((r) => r.id),
        );
        const active = await client.query(
          `select 1 from money_trail_allocations a join money_trail_records r on r.organization_id=a.organization_id and r.id in(a.sale_id,a.receipt_id)
          where a.organization_id=$1 and r.ingestion_run_id=$2 and not exists(select 1 from money_trail_reversals v where v.organization_id=a.organization_id and v.allocation_id=a.id) limit 1`,
          [input.organizationId, input.supersedesRunId],
        );
        if (active.rows.length)
          throw new MoneyTrailError(
            "Reverse the prior source’s active allocations before approving its correction.",
            "MONEY_TRAIL_REVERSE_REQUIRED",
          );
      } else if (input.supersedesRunId)
        throw new MoneyTrailError(
          "The prior financial source is not the current source for this series and month.",
          "MONEY_TRAIL_SOURCE_REVIEW_REQUIRED",
        );
      const imported = await client.query(
        `insert into money_trail_imports (organization_id, ingestion_run_id, idempotency_key, content_sha256, created_by_user_id)
        values ($1,$2,$3,$4,$5) returning id`,
        [
          input.organizationId,
          input.ingestionRunId,
          idempotencyKey,
          contentHash,
          input.actorUserId,
        ],
      );
      const importId = imported.rows[0].id;
      if (input.supersedesRunId) {
        await client.query(
          `insert into money_trail_source_supersessions(organization_id,previous_ingestion_run_id,new_ingestion_run_id,reason,created_by_user_id) values($1,$2,$3,$4,$5)`,
          [
            input.organizationId,
            input.supersedesRunId,
            input.ingestionRunId,
            correctionReason,
            input.actorUserId,
          ],
        );
        await audit(client, input, "money_trail.source_corrected", importId, {
          previousRunId: input.supersedesRunId,
          newRunId: input.ingestionRunId,
          reason: correctionReason,
        });
      }
      const recordIds = [];
      let importedCount = 0;
      for (const record of records) {
        const recordHash = hash(record);
        const existing = await client.query(
          `select id, content_sha256 from money_trail_records
          where organization_id = $1 and source_checksum = $2 and source_row_locator = $3`,
          [input.organizationId, run.checksum_sha256, record.sourceRowLocator],
        );
        let id = existing.rows[0]?.id;
        if (id && existing.rows[0].content_sha256 !== recordHash)
          throw new MoneyTrailError(
            "Original source row already exists with different content. Use an explicit classification review; source evidence cannot be replaced.",
            "MONEY_TRAIL_SOURCE_CONFLICT",
          );
        if (!id) {
          const inserted = await client.query(
            `insert into money_trail_records
            (organization_id, ingestion_run_id, raw_data_object_id, source_checksum, source_row_locator, content_sha256,
             record_date, reference, description, amount, source_content, created_by_user_id)
            values ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10::numeric,$11::jsonb,$12) returning id`,
            [
              input.organizationId,
              input.ingestionRunId,
              run.raw_data_object_id,
              run.checksum_sha256,
              record.sourceRowLocator,
              recordHash,
              record.date,
              record.reference,
              record.description,
              record.amount,
              JSON.stringify(record),
              input.actorUserId,
            ],
          );
          id = inserted.rows[0].id;
          await client.query(
            `insert into money_trail_record_states (organization_id,record_id,kind,payment_status,due_date,reference_confirmed)
            values ($1,$2,$3,$4,$5::date,$6)`,
            [
              input.organizationId,
              id,
              record.kind,
              record.paymentStatus,
              record.dueDate,
              record.referenceConfirmed,
            ],
          );
          await classificationEvent(
            client,
            input,
            id,
            1,
            record,
            "Reviewed import",
          );
          importedCount++;
        }
        await client.query(
          `insert into money_trail_import_records (organization_id,import_id,record_id) values ($1,$2,$3)`,
          [input.organizationId, importId, id],
        );
        recordIds.push(id);
      }
      await audit(client, input, "money_trail.imported", importId, {
        ingestionRunId: input.ingestionRunId,
        importedCount,
        existingCount: records.length - importedCount,
      });
      return {
        importId,
        recordIds,
        importedCount,
        existingCount: records.length - importedCount,
        idempotent: false,
        currency: "NGN",
      };
    });
  }

  async allocate(input) {
    identifier(input.saleId);
    identifier(input.receiptId);
    version(input.expectedSaleVersion);
    version(input.expectedReceiptVersion);
    const amount = decimalMoney(input.amount);
    if (input.saleId === input.receiptId)
      throw new MoneyTrailError("Sale and receipt must be different records.");
    return this.transaction(input, true, async (client) => {
      const heads = await lockRecords(client, input, [
        input.saleId,
        input.receiptId,
      ]);
      const sale = heads.find((row) => row.record_id === input.saleId);
      const receipt = heads.find((row) => row.record_id === input.receiptId);
      if (
        sale.version !== input.expectedSaleVersion ||
        receipt.version !== input.expectedReceiptVersion
      )
        conflict();
      if (
        sale.kind !== "sale" ||
        !["receipt", "credit", "refund"].includes(receipt.kind)
      )
        throw new MoneyTrailError(
          "Approve compatible sale and receipt/credit/refund classifications first.",
        );
      const result = await client.query(
        `insert into money_trail_allocations (organization_id,sale_id,receipt_id,amount,kind,created_by_user_id)
        values ($1,$2,$3,$4::numeric,$5,$6) returning id, sale_id, receipt_id, amount::text, kind, created_at`,
        [
          input.organizationId,
          input.saleId,
          input.receiptId,
          amount,
          receipt.kind,
          input.actorUserId,
        ],
      );
      await bumpVersions(client, input, [input.saleId, input.receiptId]);
      await audit(client, input, "money_trail.allocated", result.rows[0].id, {
        saleId: input.saleId,
        receiptId: input.receiptId,
        amount,
        kind: receipt.kind,
      });
      return {
        ...mapAllocation(result.rows[0]),
        saleVersion: sale.version + 1,
        receiptVersion: receipt.version + 1,
      };
    });
  }

  async reverseAllocation(input) {
    identifier(input.allocationId);
    const reason = moneyTrailText(input.reason, "Reversal reason", 1000, true);
    return this.transaction(input, true, async (client) => {
      const allocation = await client.query(
        `select id, sale_id, receipt_id from money_trail_allocations where organization_id = $1 and id = $2`,
        [input.organizationId, input.allocationId],
      );
      if (!allocation.rows[0]) notFound();
      const { sale_id: saleId, receipt_id: receiptId } = allocation.rows[0];
      await lockRecords(client, input, [saleId, receiptId]);
      const existing = await client.query(
        `select id, allocation_id, reason, created_at from money_trail_reversals where organization_id = $1 and allocation_id = $2`,
        [input.organizationId, input.allocationId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].reason !== reason)
          throw new MoneyTrailError(
            "This allocation already has an immutable reversal with another reason.",
            "MONEY_TRAIL_IDEMPOTENCY_CONFLICT",
          );
        return mapReversal(existing.rows[0]);
      }
      const result = await client.query(
        `insert into money_trail_reversals (organization_id,allocation_id,reason,created_by_user_id)
        values ($1,$2,$3,$4) returning id,allocation_id,reason,created_at`,
        [input.organizationId, input.allocationId, reason, input.actorUserId],
      );
      await bumpVersions(client, input, [saleId, receiptId]);
      await audit(
        client,
        input,
        "money_trail.allocation_reversed",
        result.rows[0].id,
        { allocationId: input.allocationId, reason },
      );
      return mapReversal(result.rows[0]);
    });
  }

  async classify(input) {
    identifier(input.id);
    version(input.expectedVersion);
    const classification = normalizeClassification(input.classification);
    return this.transaction(input, true, async (client) => {
      const [current] = await lockRecords(client, input, [input.id]);
      if (current.version !== input.expectedVersion) conflict();
      const active = await client.query(
        `select 1 from money_trail_allocations a where a.organization_id = $1 and (a.sale_id = $2 or a.receipt_id = $2)
        and not exists (select 1 from money_trail_reversals r where r.organization_id = a.organization_id and r.allocation_id = a.id) limit 1`,
        [input.organizationId, input.id],
      );
      if (active.rowCount)
        throw new MoneyTrailError(
          "Reverse active allocations before reviewing a new classification.",
          "MONEY_TRAIL_REVERSE_REQUIRED",
        );
      if (classification.referenceConfirmed) {
        const reference = await client.query(
          `select reference from money_trail_records where organization_id = $1 and id = $2`,
          [input.organizationId, input.id],
        );
        if (!reference.rows[0].reference.trim())
          throw new MoneyTrailError(
            "An empty source reference cannot be confirmed.",
          );
      }
      const result = await client.query(
        `update money_trail_record_states set version = version + 1, kind = $3, payment_status = $4, due_date = $5::date, reference_confirmed = $6
        where organization_id = $1 and record_id = $2 returning record_id,version,kind,payment_status,to_char(due_date,'YYYY-MM-DD') as due_date,reference_confirmed`,
        [
          input.organizationId,
          input.id,
          classification.kind,
          classification.paymentStatus,
          classification.dueDate,
          classification.referenceConfirmed,
        ],
      );
      await classificationEvent(
        client,
        input,
        input.id,
        result.rows[0].version,
        classification,
        classification.reason,
      );
      await audit(client, input, "money_trail.classified", input.id, {
        version: result.rows[0].version,
        ...classification,
      });
      return { id: input.id, ...mapState(result.rows[0]) };
    });
  }

  async list(input) {
    return this.transaction(input, false, (client) =>
      readMoneyTrailSnapshot(client, input),
    );
  }
}

// Same-client snapshot seam for immutable monthly evidence; no nested transaction.
export async function readMoneyTrailSnapshot(client, input) {
  const period = moneyTrailPeriod(input.period);
  // A single statement gives aggregates/details/candidates the same snapshot.
  // No monetary amount is sent through PostgreSQL JSON numeric conversion.
  const result = await client.query(LIST_SQL, [
    input.organizationId,
    period.start,
    period.endExclusive,
  ]);
  const row = result.rows[0];
  return moneyTrailReport({
    period: period.period,
    asOf: row.as_of.toISOString(),
    records: row.records.map(mapRecord),
    allocations: row.allocations
      .slice(0, MONEY_TRAIL_LIMITS.allocations)
      .map(mapAllocation),
    suggestions: row.suggestions
      .slice(0, MONEY_TRAIL_LIMITS.suggestions)
      .map((candidate) => ({
        saleId: candidate.sale_id,
        receiptId: candidate.receipt_id,
        reference: candidate.reference,
        amount: candidate.amount,
        reason: "Exact confirmed reference",
        humanApprovalRequired: true,
      })),
    sourceCorrections: row.source_corrections,
    totals: row.totals,
    reviewCounts: row.review_counts,
    recordCount: row.record_count,
    hasMoreAllocations: row.allocations.length > MONEY_TRAIL_LIMITS.allocations,
    hasMoreSuggestions: row.suggestions.length > MONEY_TRAIL_LIMITS.suggestions,
  });
}

const LIST_SQL = `with active as materialized (
  select a.id,a.sale_id,a.receipt_id,a.amount,a.kind from money_trail_allocations a
  where a.organization_id = $1 and not exists (select 1 from money_trail_reversals r where r.organization_id = a.organization_id and r.allocation_id = a.id)
), sale_sums as (
  select sale_id, coalesce(sum(amount) filter (where kind = 'receipt'),0) as paid,
    coalesce(sum(amount) filter (where kind = 'credit'),0) as credited,
    coalesce(sum(amount) filter (where kind = 'refund'),0) as refunded from active group by sale_id
), receipt_sums as (select receipt_id, sum(amount) as used from active group by receipt_id), all_records as materialized (
  select r.id,r.ingestion_run_id,r.raw_data_object_id,r.source_row_locator,r.source_checksum,r.reference,r.description,r.currency,
    to_char(r.record_date,'YYYY-MM-DD') as date,r.amount::text as amount,s.kind,s.payment_status,
    to_char(s.due_date,'YYYY-MM-DD') as due_date,s.reference_confirmed,s.version,
    coalesce(a.paid,0)::text as allocated_receipts,coalesce(a.credited,0)::text as confirmed_credits,
    coalesce(a.refunded,0)::text as allocated_refunds,
    case when s.kind = 'sale' then r.amount - coalesce(a.paid,0) - coalesce(a.credited,0) + coalesce(a.refunded,0)
      else r.amount - coalesce(p.used,0) end as remaining,
    ($2::date is null or (r.record_date >= $2::date and r.record_date < $3::date)) as in_period
  from money_trail_records r join money_trail_record_states s on s.organization_id = r.organization_id and s.record_id = r.id
  left join sale_sums a on a.sale_id = r.id left join receipt_sums p on p.receipt_id = r.id where r.organization_id = $1
    and not exists(select 1 from money_trail_source_supersessions c where c.organization_id=r.organization_id and c.previous_ingestion_run_id=r.ingestion_run_id)
), scoped as materialized (select r.* from all_records r where in_period), candidates as (
  select s.id as sale_id,p.id as receipt_id,s.reference,least(s.remaining,p.remaining)::text as amount
  from all_records s join all_records p on p.reference = s.reference and p.reference_confirmed and p.kind = 'receipt' and p.remaining > 0
  where s.kind = 'sale' and s.reference_confirmed and btrim(s.reference) <> '' and s.remaining > 0 and (s.in_period or p.in_period)
  order by s.id,p.id limit 101
)
select now() as as_of,
  (select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from(select previous_ingestion_run_id as "previousRunId",new_ingestion_run_id as "replacementRunId",reason,created_at from money_trail_source_supersessions where organization_id=$1 order by created_at desc limit 100)q) as source_corrections, (select count(*)::integer from scoped) as record_count,
  coalesce((select jsonb_agg(to_jsonb(d)) from (select r.*,r.remaining::text as remaining_amount from scoped r order by date,id limit 500) d),'[]'::jsonb) as records,
  coalesce((select jsonb_agg(to_jsonb(d)) from (
    select a.id,a.sale_id,a.receipt_id,a.amount::text,a.kind,a.created_at,
      s.date as sale_date,p.date as receipt_date,v.id as reversal_id,v.reason as reversal_reason,v.created_at as reversed_at
    from money_trail_allocations a join all_records s on s.id = a.sale_id join all_records p on p.id = a.receipt_id
    left join money_trail_reversals v on v.organization_id = a.organization_id and v.allocation_id = a.id
    where a.organization_id = $1 and (s.in_period or p.in_period) order by a.created_at,a.id limit 501
  ) d),'[]'::jsonb) as allocations,
  coalesce((select jsonb_agg(to_jsonb(c)) from candidates c),'[]'::jsonb) as suggestions,
  (select jsonb_build_object(
    'recordedSales',coalesce(sum(amount::numeric) filter (where kind = 'sale'),0)::text,
    'customerReceipts',coalesce(sum(amount::numeric) filter (where kind = 'receipt'),0)::text,
    'credits',coalesce(sum(amount::numeric) filter (where kind = 'credit'),0)::text,
    'refunds',coalesce(sum(amount::numeric) filter (where kind = 'refund'),0)::text,
    'ownerMovements',coalesce(sum(amount::numeric) filter (where kind = 'owner_movement'),0)::text,
    'allocatedReceipts',coalesce(sum(allocated_receipts::numeric) filter (where kind = 'sale'),0)::text,
    'confirmedCredits',coalesce(sum(confirmed_credits::numeric) filter (where kind = 'sale'),0)::text,
    'allocatedRefunds',coalesce(sum(allocated_refunds::numeric) filter (where kind = 'sale'),0)::text,
    'confirmedBalance',coalesce(sum(remaining) filter (where kind = 'sale' and payment_status = 'confirmed_receivable'),0)::text,
    'unallocatedReceipts',coalesce(sum(remaining) filter (where kind = 'receipt'),0)::text
  ) from scoped) as totals,
  (select jsonb_build_object(
    'classificationRequired',count(*) filter (where kind = 'unknown'),
    'unknownPaymentStatus',count(*) filter (where kind = 'sale' and payment_status = 'unknown'),
    'confirmedOpenReceivables',count(*) filter (where kind = 'sale' and payment_status = 'confirmed_receivable' and remaining > 0),
    'unallocatedReceipts',count(*) filter (where kind = 'receipt' and remaining > 0),
    'unallocatedAdjustments',count(*) filter (where kind in ('credit','refund') and remaining > 0)
  ) from scoped) as review_counts`;

function identifier(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new MoneyTrailError("A valid UUID identifier is required.");
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 2147483647)
    throw new MoneyTrailError(
      "A positive expected record version is required.",
    );
}
function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function conflict() {
  throw new MoneyTrailError(
    "Records changed; refresh before approving.",
    "MONEY_TRAIL_VERSION_CONFLICT",
  );
}
function notFound() {
  throw new MoneyTrailError(
    "Money Trail record not found.",
    "MONEY_TRAIL_NOT_FOUND",
  );
}

async function lockRecords(client, input, ids) {
  const result = await client.query(
    `select record_id,version,kind,payment_status from money_trail_record_states
    where organization_id = $1 and record_id = any($2::uuid[]) order by record_id for update`,
    [input.organizationId, ids],
  );
  if (result.rowCount !== ids.length) notFound();
  const superseded = await client.query(
    `select 1 from money_trail_records r join money_trail_source_supersessions c
    on c.organization_id=r.organization_id and c.previous_ingestion_run_id=r.ingestion_run_id
    where r.organization_id=$1 and r.id=any($2::uuid[]) limit 1`,
    [input.organizationId, ids],
  );
  if (superseded.rows.length)
    throw new MoneyTrailError(
      "The source was superseded. Review the replacement source.",
      "MONEY_TRAIL_SOURCE_REVIEW_REQUIRED",
    );
  return result.rows;
}
async function bumpVersions(client, input, ids) {
  await client.query(
    `update money_trail_record_states set version = version + 1 where organization_id = $1 and record_id = any($2::uuid[])`,
    [input.organizationId, ids],
  );
}
async function classificationEvent(
  client,
  input,
  id,
  currentVersion,
  classification,
  reason,
) {
  const { kind, paymentStatus, dueDate, referenceConfirmed } = classification;
  await client.query(
    `insert into money_trail_classifications (organization_id,record_id,version,classification,reason,created_by_user_id)
    values ($1,$2,$3,$4::jsonb,$5,$6)`,
    [
      input.organizationId,
      id,
      currentVersion,
      JSON.stringify({ kind, paymentStatus, dueDate, referenceConfirmed }),
      reason,
      input.actorUserId,
    ],
  );
}
async function audit(client, input, eventType, targetId, metadata) {
  await client.query(
    `insert into audit_events (organization_id,actor_user_id,event_type,target_type,target_id,metadata)
    values ($1,$2,$3,'money_trail',$4,$5::jsonb)`,
    [
      input.organizationId,
      input.actorUserId,
      eventType,
      targetId,
      JSON.stringify(metadata),
    ],
  );
}
function mapState(row) {
  return {
    version: row.version,
    kind: row.kind,
    paymentStatus: row.payment_status,
    dueDate: row.due_date,
    referenceConfirmed: row.reference_confirmed,
  };
}
function mapRecord(row) {
  return {
    id: row.id,
    ingestionRunId: row.ingestion_run_id,
    rawDataObjectId: row.raw_data_object_id,
    sourceRowLocator: row.source_row_locator,
    sourceChecksum: row.source_checksum,
    date: row.date,
    reference: row.reference,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    ...mapState(row),
    allocatedReceipts: row.allocated_receipts,
    confirmedCredits: row.confirmed_credits,
    allocatedRefunds: row.allocated_refunds,
    confirmedBalance:
      row.kind === "sale" && row.payment_status === "confirmed_receivable"
        ? row.remaining_amount
        : null,
    remainingAmount: row.remaining_amount,
  };
}
function mapAllocation(row) {
  return {
    id: row.id,
    saleId: row.sale_id,
    receiptId: row.receipt_id,
    amount: row.amount,
    kind: row.kind,
    createdAt: row.created_at,
    saleDate: row.sale_date ?? null,
    receiptDate: row.receipt_date ?? null,
    reversalId: row.reversal_id ?? null,
    reversalReason: row.reversal_reason ?? null,
    reversedAt: row.reversed_at ?? null,
  };
}
function mapReversal(row) {
  return {
    id: row.id,
    allocationId: row.allocation_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
