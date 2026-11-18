/**
 * §10 — four dashboards, metric definitions agreed in writing:
 *  - Speed to lead: first inbound → first human outbound, business minutes; median & p90 (never mean)
 *  - Contact rate: leads where client replied at least once (after our touch) ÷ leads created
 *  - Qualification rate: leads reaching Qualified ÷ leads created
 *  - Win rate: Won ÷ (Won + Lost), excluding Disqualified and open
 *  - Leakage: open leads with no activity in 7 days ÷ open leads
 *  - Unanswered 24h: conversations whose last message is inbound and older than 24h
 *  - Cost per conversation: Meta's billed messages (pricing category from status webhooks)
 *
 * Heavy aggregates read materialised views refreshed every few minutes (mv_*), so reports never
 * slow down the inbox.
 */
import { sql } from "drizzle-orm";
import { env } from "@lead/config";
import type { Db } from "@lead/db";

export type DateRange = { from: Date; to: Date };

const rows = async <T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(q)).rows as T[];

export async function refreshReportViews(db: Db): Promise<void> {
  for (const v of ["mv_lead_funnel", "mv_rep_response", "mv_template_perf", "mv_wa_cost"]) {
    await db.execute(sql.raw(`refresh materialized view concurrently ${v}`)).catch(async () => {
      await db.execute(sql.raw(`refresh materialized view ${v}`));
    });
  }
}

export async function todayDashboard(db: Db) {
  type TodayCounts = Record<
    | "unassigned" | "awaiting_reply" | "sla_at_risk" | "sla_breached" | "received_today" | "sent_today" | "failed_24h"
    | "outbound_queue" | "unprocessed_events" | "failed_events" | "leads_today" | "unanswered_24h" | "parse_failures_open",
    number
  >;
  const [counts] = await rows<TodayCounts>(
    db,
    sql`select
      (select count(*)::int from leads where owner_id is null and closed_at is null and not is_junk) as unassigned,
      (select count(*)::int from conversations where state = 'waiting_us' and not is_junk) as awaiting_reply,
      (select count(*)::int from sla_timers where state = 'running' and warned_at is not null and breached_at is null) as sla_at_risk,
      (select count(*)::int from sla_timers where state = 'running' and breached_at is not null) as sla_breached,
      (select count(*)::int from messages where direction = 'inbound' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as received_today,
      (select count(*)::int from messages where direction = 'outbound' and status not in ('queued','cancelled') and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as sent_today,
      (select count(*)::int from messages where status = 'failed' and created_at > now() - interval '24 hours') as failed_24h,
      (select count(*)::int from messages where status in ('queued','sending') and (send_at is null or send_at <= now())) as outbound_queue,
      (select count(*)::int from webhook_events where processed_at is null) as unprocessed_events,
      (select count(*)::int from webhook_events where processed_at is null and error is not null) as failed_events,
      (select count(*)::int from leads where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as leads_today,
      (select count(*)::int from conversations c where c.last_direction = 'inbound' and c.last_message_at < now() - interval '24 hours' and c.state <> 'closed' and not c.is_junk) as unanswered_24h,
      (select count(*)::int from parse_failures where resolved_at is null) as parse_failures_open`,
  );
  const serviceUsage = await rows<{ wa_number_id: string | null; service_count: number }>(
    db,
    sql`select c.wa_number_id, count(*)::int as service_count
        from messages m join conversations c on c.id = m.conversation_id
        where m.channel = 'whatsapp' and m.direction = 'outbound'
          and coalesce(m.pricing_category, case when m.kind = 'template' then 'utility' else 'service' end) = 'service'
          and m.status in ('sent','delivered','read')
          and m.created_at >= date_trunc('month', now())
        group by c.wa_number_id`,
  );
  const numbers = await rows<{ display_number: string; quality_rating: string | null; messaging_limit: string | null; phone_number_id: string }>(
    db,
    sql`select phone_number_id, display_number, quality_rating, messaging_limit from wa_numbers`,
  );
  return { ...(counts as TodayCounts), serviceAllowance: env.WA_FREE_SERVICE_ALLOWANCE, serviceUsage, numbers };
}

export async function funnelReport(db: Db, r: DateRange) {
  return rows<Record<string, unknown>>(
    db,
    sql`select source, to_char(month, 'YYYY-MM') as month,
          sum(created)::int as created, sum(contacted)::int as contacted, sum(engaged)::int as engaged,
          sum(qualified)::int as qualified, sum(quoted)::int as quoted, sum(won)::int as won, sum(lost)::int as lost,
          sum(value_won)::numeric as value_won
        from mv_lead_funnel where month >= date_trunc('month', ${r.from.toISOString()}::timestamptz) and month <= ${r.to.toISOString()}::timestamptz
        group by source, month order by month desc, created desc`,
  );
}

export async function teamReport(db: Db, r: DateRange) {
  return rows<Record<string, unknown>>(
    db,
    sql`select u.id as user_id, u.name,
          count(l.id)::int as leads_handled,
          percentile_cont(0.5) within group (order by l.first_response_business_minutes) as median_first_response,
          percentile_cont(0.9) within group (order by l.first_response_business_minutes) as p90_first_response,
          round(100.0 * count(*) filter (where l.last_client_reply_at is not null) / nullif(count(l.id), 0), 1) as reply_rate,
          round(100.0 * count(*) filter (where exists (select 1 from activities a where a.lead_id = l.id and a.type = 'stage_changed' and a.payload->>'to' = 'qualified')) / nullif(count(l.id), 0), 1) as qualification_rate,
          round(100.0 * count(*) filter (where l.stage = 'won') / nullif(count(*) filter (where l.stage in ('won','lost')), 0), 1) as win_rate,
          round(avg(l.value_estimate) filter (where l.stage = 'won'), 0) as avg_deal_value,
          (select count(*)::int from leads l2 where l2.owner_id = u.id and l2.closed_at is null and l2.last_activity_at < now() - interval '7 days') as stale_open_leads
        from users u
        left join leads l on l.owner_id = u.id and l.created_at between ${r.from.toISOString()}::timestamptz and ${r.to.toISOString()}::timestamptz and not l.is_junk
        where u.active and u.role in ('rep','manager')
        group by u.id, u.name order by leads_handled desc`,
  );
}

export async function channelCostReport(db: Db, r: DateRange) {
  const byCategory = await rows<Record<string, unknown>>(
    db,
    sql`select month, category, country, sum(messages)::int as messages, sum(billable_messages)::int as billable_messages, round(sum(cost)::numeric, 2) as cost, max(currency) as currency
        from mv_wa_cost where month >= date_trunc('month', ${r.from.toISOString()}::timestamptz) and month <= ${r.to.toISOString()}::timestamptz
        group by month, category, country order by month desc, category`,
  );
  const templatePerf = await rows<Record<string, unknown>>(db, sql`select * from mv_template_perf order by sent desc`);
  const [unit] = await rows<Record<string, unknown>>(
    db,
    sql`with cost as (select coalesce(sum(cost),0) as total from mv_wa_cost where month >= date_trunc('month', ${r.from.toISOString()}::timestamptz) and month <= ${r.to.toISOString()}::timestamptz),
        l as (select count(*) as n, count(*) filter (where stage = 'won') as won from leads where created_at between ${r.from.toISOString()}::timestamptz and ${r.to.toISOString()}::timestamptz and not is_junk)
        select round(cost.total::numeric, 2) as wa_spend, l.n::int as leads, l.won::int as won,
          round((cost.total / nullif(l.n, 0))::numeric, 2) as cost_per_lead,
          round((cost.total / nullif(l.won, 0))::numeric, 2) as cost_per_won
        from cost, l`,
  );
  const [email] = await rows<Record<string, unknown>>(
    db,
    sql`select count(*) filter (where direction = 'outbound' and status in ('sent','delivered','read'))::int as emails_sent,
          count(*) filter (where direction = 'outbound' and error_code = 'hard_bounce')::int as hard_bounces,
          count(*) filter (where direction = 'outbound' and error_code = 'soft_bounce')::int as soft_bounces,
          round(100.0 * count(*) filter (where error_code in ('hard_bounce','soft_bounce')) / nullif(count(*) filter (where direction = 'outbound'), 0), 2) as bounce_rate
        from messages where channel = 'email' and created_at between ${r.from.toISOString()}::timestamptz and ${r.to.toISOString()}::timestamptz`,
  );
  return { byCategory, templatePerf, unit, email };
}

export async function speedToLead(db: Db, r: DateRange) {
  const [row] = await rows<Record<string, number | null>>(
    db,
    sql`select percentile_cont(0.5) within group (order by first_response_business_minutes) as median,
              percentile_cont(0.9) within group (order by first_response_business_minutes) as p90,
              count(*)::int as n,
              round(100.0 * count(*) filter (where first_response_business_minutes <= 5) / nullif(count(*), 0), 1) as pct_under_5,
              (select percentile_cont(0.5) within group (order by extract(epoch from (assigned_at - opened_at)) / 60) from leads where assigned_at is not null and created_at between ${r.from.toISOString()}::timestamptz and ${r.to.toISOString()}::timestamptz) as median_minutes_to_assign
        from leads where first_response_business_minutes is not null and created_at between ${r.from.toISOString()}::timestamptz and ${r.to.toISOString()}::timestamptz`,
  );
  const [rates] = await rows<Record<string, number | null>>(
    db,
    sql`select count(*)::int as created,
          round(100.0 * count(*) filter (where last_client_reply_at is not null) / nullif(count(*), 0), 1) as contact_rate,
          round(100.0 * count(*) filter (where stage = 'won') / nullif(count(*) filter (where stage in ('won','lost')), 0), 1) as win_rate,
          percentile_cont(0.5) within group (order by extract(epoch from (won_at - opened_at)) / 86400) filter (where won_at is not null) as median_cycle_days
        from leads where created_at between ${r.from.toISOString()}::timestamptz and ${r.to.toISOString()}::timestamptz and not is_junk`,
  );
  const [leak] = await rows<Record<string, number | null>>(
    db,
    sql`select round(100.0 * count(*) filter (where last_activity_at < now() - interval '7 days') / nullif(count(*), 0), 1) as leakage,
          count(*)::int as open_leads
        from leads where closed_at is null and not is_junk`,
  );
  return { ...row, ...rates, ...leak };
}
