import type { PoolClient, QueryResultRow } from "pg";

export type TbankPaymentIdentityOwner = QueryResultRow & {
  id: number;
  order_id: string;
};

/**
 * Serializes every local attempt to claim one provider PaymentId. Callers must
 * already be inside a database transaction so the lock is released on commit.
 */
export async function lockTbankPaymentIdentity(
  client: PoolClient,
  paymentId: string,
): Promise<void> {
  await client.query(
    `
      /* tbank_payment_identity:lock */
      select pg_advisory_xact_lock(hashtextextended($1, 0))
    `,
    [`tbank:${paymentId}`],
  );
}

export async function findOtherTbankPaymentIdentityOwner(
  client: PoolClient,
  paymentId: string,
  attemptId: number,
): Promise<TbankPaymentIdentityOwner | null> {
  const result = await client.query<TbankPaymentIdentityOwner>(
    `
      /* tbank_payment_identity:owner */
      select id, order_id
      from public.merch_payment_attempts
      where provider = 'tbank'
        and external_payment_id = $1
        and id <> $2
      limit 1
    `,
    [paymentId, attemptId],
  );
  return result.rows[0] ?? null;
}
