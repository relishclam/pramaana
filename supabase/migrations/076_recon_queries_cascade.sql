-- recon_queries.bank_txn_id was missing ON DELETE CASCADE,
-- blocking recon_statements DELETE from cascading through recon_transactions.
ALTER TABLE pramaana.recon_queries
  DROP CONSTRAINT IF EXISTS recon_queries_bank_txn_id_fkey;

ALTER TABLE pramaana.recon_queries
  ADD CONSTRAINT recon_queries_bank_txn_id_fkey
  FOREIGN KEY (bank_txn_id)
  REFERENCES pramaana.recon_transactions(id)
  ON DELETE CASCADE;
