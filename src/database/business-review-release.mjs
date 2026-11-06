// Release metadata contains no financial data and is read-only to the runtime.
export class PostgresBusinessReviewRelease {
  constructor(pool) {
    this.pool = pool;
  }
  async allowed({ organizationId }) {
    const schema = await this.pool.query(
      "select to_regclass('public.business_review_release') as relation",
    );
    if (!schema.rows[0].relation) return false;
    const grant = await this.pool.query(
      "select has_table_privilege('public.business_review_release','SELECT') as permitted",
    );
    if (!grant.rows[0].permitted) return false;
    const result = await this.pool.query(
      "select enabled or pilot_organization_id=$1::uuid as enabled from business_review_release where singleton",
      [organizationId],
    );
    return result.rows[0]?.enabled === true;
  }
}
