-- Paid amount checks (ADR 0006 §13, docs/secrets.md): what the provider reported as
-- charged on the paid event, and why an order failed (amount, currency or provider
-- did not match the order; nothing was granted). Admin dashboard only. Nullable,
-- like every projected column (tombstones insert bare rows).
ALTER TABLE purchase ADD COLUMN paid_currency TEXT;
ALTER TABLE purchase ADD COLUMN paid_minor INTEGER;
ALTER TABLE purchase ADD COLUMN fail_reason TEXT;
