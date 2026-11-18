-- §10 materialised views. Refreshed every few minutes by the worker (refresh ... concurrently).

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_lead_funnel AS
SELECT
  date_trunc('month', l.created_at) AS month,
  l.source,
  count(*) AS created,
  count(*) FILTER (WHERE l.touch_count > 0 OR l.first_response_at IS NOT NULL) AS contacted,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'stage_changed' AND a.payload->>'to' IN ('engaged','qualified','quoted','negotiation','won'))) AS engaged,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'stage_changed' AND a.payload->>'to' IN ('qualified','quoted','negotiation','won'))) AS qualified,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'stage_changed' AND a.payload->>'to' IN ('quoted','negotiation','won'))) AS quoted,
  count(*) FILTER (WHERE l.stage = 'won') AS won,
  count(*) FILTER (WHERE l.stage = 'lost') AS lost,
  coalesce(sum(l.value_estimate) FILTER (WHERE l.stage = 'won'), 0) AS value_won
FROM leads l
WHERE NOT l.is_junk
GROUP BY 1, 2;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mv_lead_funnel_uq ON mv_lead_funnel (month, source);
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rep_response AS
SELECT
  date_trunc('day', l.first_response_at) AS day,
  l.first_response_by AS user_id,
  count(*) AS n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY l.first_response_business_minutes) AS median_minutes,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY l.first_response_business_minutes) AS p90_minutes
FROM leads l
WHERE l.first_response_at IS NOT NULL AND l.first_response_business_minutes IS NOT NULL
GROUP BY 1, 2;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mv_rep_response_uq ON mv_rep_response (day, user_id);
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_template_perf AS
SELECT
  t.id AS template_id,
  t.internal_name,
  t.category,
  t.language,
  count(m.id) FILTER (WHERE m.status IN ('sent','delivered','read')) AS sent,
  count(m.id) FILTER (WHERE m.delivered_at IS NOT NULL) AS delivered,
  count(m.id) FILTER (WHERE m.read_at IS NOT NULL) AS read,
  count(m.id) FILTER (WHERE m.status = 'failed') AS failed,
  count(m.id) FILTER (WHERE EXISTS (
    SELECT 1 FROM messages r WHERE r.conversation_id = m.conversation_id AND r.direction = 'inbound'
      AND r.created_at > m.created_at AND r.created_at < m.created_at + interval '72 hours')) AS replied,
  round(100.0 * count(m.id) FILTER (WHERE m.read_at IS NOT NULL) / nullif(count(m.id) FILTER (WHERE m.delivered_at IS NOT NULL), 0), 1) AS read_rate
FROM templates t
LEFT JOIN messages m ON m.template_id = t.id
GROUP BY t.id, t.internal_name, t.category, t.language;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mv_template_perf_uq ON mv_template_perf (template_id);
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_wa_cost AS
SELECT
  date_trunc('month', m.created_at) AS month,
  coalesce(m.pricing_category, CASE WHEN m.kind = 'template' THEN coalesce(t.category, 'utility') ELSE 'service' END) AS category,
  coalesce(m.recipient_country, 'IN') AS country,
  count(*) AS messages,
  count(*) FILTER (WHERE coalesce(m.billable, true)) AS billable_messages,
  coalesce(sum(CASE WHEN coalesce(m.billable, true) THEN rc.rate ELSE 0 END), 0) AS cost,
  max(rc.currency) AS currency
FROM messages m
LEFT JOIN templates t ON t.id = m.template_id
LEFT JOIN LATERAL (
  SELECT r.rate, r.currency FROM rate_card r
  WHERE r.country = coalesce(m.recipient_country, 'IN')
    AND r.category = coalesce(m.pricing_category, CASE WHEN m.kind = 'template' THEN coalesce(t.category, 'utility') ELSE 'service' END)
    AND r.effective_from <= m.created_at::date
  ORDER BY r.effective_from DESC LIMIT 1
) rc ON true
WHERE m.channel = 'whatsapp' AND m.direction = 'outbound' AND m.status IN ('sent','delivered','read')
GROUP BY 1, 2, 3;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mv_wa_cost_uq ON mv_wa_cost (month, category, country);
