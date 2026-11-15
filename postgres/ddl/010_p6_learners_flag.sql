-- P6 learners stay off until Gate G-3 passes (Layer 18 §10).
-- Platform database, not Annex A. apply-annex-a.sh does not apply this file.
-- Kept out of 002_platform.sql so the platform seed file is not edited for this flag.
INSERT INTO feature_flags (flag, description, default_enabled, layer) VALUES
 ('LEARNERS_ENABLED','Learning components stay off until Gate G-3 passes',false,'L17_5')
 ON CONFLICT DO NOTHING;
