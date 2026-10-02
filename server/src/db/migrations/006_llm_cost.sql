-- 006_llm_cost.sql — estimated spend per LLM call (Step 3).
-- llm_calls predates cost tracking; nullable keeps old rows valid.
ALTER TABLE llm_calls ADD COLUMN cost_usd REAL;
