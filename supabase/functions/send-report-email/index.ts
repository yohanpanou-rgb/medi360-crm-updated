// Supabase Edge Function — sends the "Αναφορές" (Reports) summary as an email.
//
// Called from index.html via:
//   sb.functions.invoke('send-report-email', { body: { to, clinic_name, range, stats } })
//
// Deploy with:
//   supabase functions deploy send-report-email
//
// Required secrets (set once via `supabase secrets set`, see README further down):
//   RESEND_API_KEY     — API key from resend.com
//   REPORT_FROM_EMAIL  — a sender address verified in Resend (e.g. reports@yourdomain.gr)
//
// SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically by the Supabase
// runtime — no need to set those as secrets yourself.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(s: unknown) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function euro(v: number | null | undefined) {
  if (v === null || v === undefined) return '—';
  return '€' + v.toLocaleString('el-GR');
}

interface TopService { name: string; count: number; revenue: number; }
interface ReportStats {
  appointments: number;
  revenue: number | null;
  new_patients: number;
  new_patients_delta?: number | null;
  new_patients_pct?: number | null;
  no_show_rate: number | null;
  gdpr_rate: number | null;
  utilization_rate?: number | null;
  consultations?: number | null;
  consultations_delta?: number | null;
  consultations_pct?: number | null;
  recommended_done?: number | null;
  recommended_total?: number | null;
  top_services: TopService[];
}

function deltaLabel(diff?: number | null, pct?: number | null) {
  if (diff === null || diff === undefined) return '';
  const color = diff > 0 ? '#0F6E56' : diff < 0 ? '#A32D2D' : '#5b6380';
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '▬';
  const pctAbs = Math.abs(pct ?? 0);
  return ` <span style="color:${color};font-weight:700">${diff > 0 ? '+' : ''}${diff} (${arrow}${pctAbs}%)</span> vs προηγ. περίοδο`;
}

function renderReportEmailHtml(opts: {
  clinic_name?: string;
  range?: { from: string; to: string };
  stats: ReportStats;
  sender?: string;
}) {
  const { clinic_name, range, stats, sender } = opts;
  const rows = (stats.top_services || []).map(s => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#1a1f3a">${escapeHtml(s.name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#1a1f3a">${s.count}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#1a1f3a">${stats.revenue === null ? '—' : euro(s.revenue)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f6f8fc;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px">
    <div style="background:#1a1f3a;border-radius:12px 12px 0 0;padding:24px;text-align:center">
      <div style="color:#fff;font-size:20px;font-weight:700">${escapeHtml(clinic_name || 'medi360 CRM')}</div>
      <div style="color:rgba(255,255,255,.6);font-size:13px;margin-top:4px">Αναφορά ${escapeHtml(range?.from)} — ${escapeHtml(range?.to)}</div>
    </div>
    <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:12px;background:#eef0fe;border-radius:8px 0 0 8px;width:33%">
            <div style="font-size:11px;color:#5b6380;text-transform:uppercase">Ραντεβού</div>
            <div style="font-size:20px;font-weight:700;color:#2B3BF0">${stats.appointments}</div>
          </td>
          <td style="width:6px"></td>
          <td style="padding:12px;background:#eef0fe;width:33%">
            <div style="font-size:11px;color:#5b6380;text-transform:uppercase">Έσοδα</div>
            <div style="font-size:20px;font-weight:700;color:#2B3BF0">${euro(stats.revenue)}</div>
          </td>
          <td style="width:6px"></td>
          <td style="padding:12px;background:#eef0fe;border-radius:0 8px 8px 0;width:33%">
            <div style="font-size:11px;color:#5b6380;text-transform:uppercase">Νέοι Πελάτες</div>
            <div style="font-size:20px;font-weight:700;color:#2B3BF0">${stats.new_patients}</div>
          </td>
        </tr>
      </table>
      <div style="font-size:13px;color:#5b6380;margin-bottom:8px">
        No-show rate: <b style="color:#1a1f3a">${stats.no_show_rate === null ? '—' : stats.no_show_rate + '%'}</b>
        &nbsp;·&nbsp;
        GDPR συμμόρφωση: <b style="color:#1a1f3a">${stats.gdpr_rate === null ? '—' : stats.gdpr_rate + '%'}</b>
        &nbsp;·&nbsp;
        Κάλυψη ωραρίου: <b style="color:#1a1f3a">${stats.utilization_rate == null ? '—' : stats.utilization_rate + '%'}</b>
      </div>
      <div style="font-size:13px;color:#5b6380;margin-bottom:16px">
        Νέοι πελάτες:${deltaLabel(stats.new_patients_delta, stats.new_patients_pct)}
        &nbsp;·&nbsp;
        Consultations (${stats.consultations ?? 0}):${deltaLabel(stats.consultations_delta, stats.consultations_pct)}
        ${stats.recommended_total ? `&nbsp;·&nbsp; Υπηρεσίες από consultation που έγιναν: <b style="color:#1a1f3a">${stats.recommended_done}/${stats.recommended_total}</b>` : ''}
      </div>
      <div style="font-size:14px;font-weight:600;color:#1a1f3a;margin-bottom:8px">Κορυφαίες Υπηρεσίες</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px" cellpadding="0" cellspacing="0">
        <thead>
          <tr style="text-align:left;color:#5b6380;font-size:11px;text-transform:uppercase">
            <th style="padding:8px 12px">Υπηρεσία</th><th style="padding:8px 12px">Ραντεβού</th><th style="padding:8px 12px">Έσοδα</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="3" style="padding:12px;color:#9aa0b8">Χωρίς δεδομένα</td></tr>'}</tbody>
      </table>
    </div>
    <div style="text-align:center;padding:16px;font-size:11px;color:#9aa0b8">
      Στάλθηκε από ${escapeHtml(sender || 'medi360')} · Powered by medi360
    </div>
  </div>
</body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    // Client scoped to the caller's own JWT — RLS decides what they can see,
    // so this can never be tricked into reading someone else's profile/role.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('role, full_name')
      .eq('id', user.id)
      .single();
    if (profileErr || !profile) return json({ error: 'Profile not found' }, 403);

    // Server-side role gate — mirrors the sidebar's client-side check, but this
    // is the one that actually matters since the client-side check is only UI.
    if (!['super_admin', 'clinic_admin'].includes(profile.role)) {
      return json({ error: 'Δεν έχεις δικαίωμα αποστολής αναφορών' }, 403);
    }

    const body = await req.json().catch(() => null);
    const to = body?.to;
    const stats = body?.stats;
    if (!to || !stats) return json({ error: 'Λείπουν στοιχεία (to/stats)' }, 400);

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ error: 'RESEND_API_KEY δεν έχει ρυθμιστεί στα Supabase secrets' }, 500);
    const fromEmail = Deno.env.get('REPORT_FROM_EMAIL') || 'onboarding@resend.dev';

    const html = renderReportEmailHtml({
      clinic_name: body.clinic_name,
      range: body.range,
      stats,
      sender: profile.full_name,
    });

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: `Αναφορά ${body.clinic_name || 'Κλινικής'} (${body.range?.from} — ${body.range?.to})`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return json({ error: `Αποτυχία αποστολής email: ${errText}` }, 502);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Άγνωστο σφάλμα' }, 500);
  }
});
