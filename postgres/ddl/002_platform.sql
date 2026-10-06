-- SIKANDER AI — firm-owned platform tables (Layer 18 §5.1). Phase 0.
CREATE TABLE IF NOT EXISTS feature_flags (flag TEXT PRIMARY KEY, description TEXT NOT NULL, default_enabled BOOLEAN DEFAULT false, layer TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
INSERT INTO feature_flags VALUES
 ('CORE_ENABLED','Core spine',true,'CORE'),('L17_1_ENABLED','Temporal-law binding',true,'L17_1'),('L17_2_ENABLED','Entity resolution',true,'L17_2'),('L17_3_ENABLED','Privilege propagation',true,'L17_3'),
 ('L17_4_ENABLED','Proposition engine',true,'L17_4'),('L17_5_ENABLED','Master-Knowledge single writer',true,'L17_5'),('L17_6_ENABLED','Accounts intimation chain',true,'L17_6'),('L17_7_ENABLED','Universal authority viewer',true,'L17_7'),
 ('L17_8A_ENABLED','Auto-Clerk ambiguity queue',true,'L17_8'),('L17_8B_ENABLED','Case-number follow-up',true,'L17_8'),('L17_10_ENABLED','Corpus contract',true,'L17_10'),('L17_11_ENABLED','Authority integrity',true,'L17_11'),
 ('L9_2_BILLING','Subscription invoicing (GATED)',false,'L9_2'),('WA_31_CUT','Deferred v6 WhatsApp commands beyond the 8-command grammar',false,'D2_1'),('L18_TEMPLATE_EXAMPLE','Amendment-layer template',false,'L18_X'),
 ('LEGACY_GOVERNANCE_CHAINS','Frozen out-of-spec ops-reporting and filing-transport chains (Erratum E-24)',false,'E_24')
 ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS firm_feature_overrides (firm_id TEXT NOT NULL, flag TEXT REFERENCES feature_flags(flag), enabled BOOLEAN NOT NULL, rollout_percent SMALLINT DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100), updated_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (firm_id, flag));
CREATE TABLE IF NOT EXISTS firm_decisions_register (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), firm_id TEXT NOT NULL, decision_key TEXT NOT NULL, decision_value TEXT NOT NULL, effective_from DATE NOT NULL, decided_by TEXT NOT NULL, reason TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS idempotency_keys (firm_id TEXT NOT NULL, key UUID NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (firm_id, key));
CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_keys (created_at);
-- TODO(firm) O-8: retention period; O-11: rule numbers — no values invented here.
