// Dibs uptime monitor.
//
// Runs on GitHub Actions every 5 minutes, outside Supabase, so it keeps
// running when the Dibs database is down. On 15 October 2026 the database
// froze for 7 hours and every alarm we had lived inside it.
//
// When a check fails twice in a row (45 seconds apart), it:
//   - posts to Slack (SLACK_WEBHOOK_URL, if set),
//   - emails everyone in ALERT_EMAILS through Brevo,
//   - phones everyone in ALERT_PHONES through Twilio (only when forms are down),
//   - opens a GitHub issue, which is also how it remembers an outage.
// While it lasts: a reminder every 30 minutes, and up to 3 calls in all.
// When it is over: "back up" on Slack and email, and the issue is closed.
//
// No secrets live in this file. Everything comes from repository secrets.

const env = process.env;
const REPO = env.GITHUB_REPOSITORY;
const TEST = env.TEST_ALERT === "true";
const REMIND_MIN = 30;
const MAX_CALLS = 3;
const SUPABASE_DASH = "https://supabase.com/dashboard/project/slkckmmambdsbnkdeped";

const CHECKS = [
  {
    name: "Dibs forms (form settings, needs the database)",
    critical: true,
    url: () => `https://slkckmmambdsbnkdeped.supabase.co/functions/v1/widget-config?slug=qubesheets&forceFunctionRegion=us-west-2&monitor=${Date.now()}`,
    ok: (status, body) => status === 200 && body.includes('"widget_id"'),
  },
  {
    name: "Form script (app.hellodibs.com/widget.js)",
    critical: true,
    url: () => "https://app.hellodibs.com/widget.js",
    ok: (status, body) => status === 200 && body.length > 50000,
  },
  {
    name: "Dashboard (app.hellodibs.com)",
    critical: false,
    url: () => "https://app.hellodibs.com/login",
    ok: (status) => status === 200,
  },
  {
    name: "Website (hellodibs.com)",
    critical: false,
    url: () => "https://hellodibs.com/",
    ok: (status) => status === 200,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(check) {
  const started = Date.now();
  try {
    const res = await fetch(check.url(), { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "dibs-uptime-monitor" } });
    const body = await res.text();
    const ms = Date.now() - started;
    return check.ok(res.status, body) ? null : `HTTP ${res.status} after ${ms} ms`;
  } catch (e) {
    return `no answer after ${Date.now() - started} ms (${e.name === "TimeoutError" ? "timed out" : e.message})`;
  }
}

async function runChecks() {
  const first = await Promise.all(CHECKS.map(probe));
  const suspects = CHECKS.map((c, i) => ({ ...c, reason: first[i] })).filter((c) => c.reason);
  if (!suspects.length) return [];
  console.log("First pass failed:", suspects.map((c) => `${c.name}: ${c.reason}`).join("; "), "- checking again in 45 s");
  await sleep(45000);
  const second = await Promise.all(suspects.map(probe));
  return suspects.map((c, i) => ({ ...c, reason: second[i] })).filter((c) => c.reason);
}

// ── GitHub issue: the outage record and the monitor's memory ────────────
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}
const openOutage = async () => (await gh("/issues?labels=outage&state=open&per_page=1"))[0] || null;
const comments = async (n) => gh(`/issues/${n}/comments?per_page=100`);

// ── Channels ─────────────────────────────────────────────────────────────
async function slack(text) {
  if (!env.SLACK_WEBHOOK_URL) return "skipped (no SLACK_WEBHOOK_URL yet)";
  const res = await fetch(env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  return res.ok ? "sent" : `failed HTTP ${res.status}`;
}

async function email(subject, text) {
  const to = (env.ALERT_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!env.BREVO_API_KEY || !to.length) return "skipped (no key or no recipients)";
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${text
    .split("\n").map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>")}</div>`;
  // One message per person, so nobody's address is shown to the others.
  const results = await Promise.all(to.map(async (addr) => {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Dibs Alert", email: "noreply@notify.hellodibs.com" }, to: [{ email: addr }], subject, htmlContent: html, textContent: text }),
    });
    return res.ok ? "sent" : `failed HTTP ${res.status}`;
  }));
  return `${results.filter((r) => r === "sent").length} of ${to.length} sent`;
}

async function call(spoken) {
  const to = (env.ALERT_PHONES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM || !to.length) return "skipped (no Twilio settings)";
  const say = spoken.replace(/[<>&"']/g, " ");
  const twiml = `<Response><Pause length="1"/><Say voice="Polly.Joanna">${say}</Say><Pause length="1"/><Say voice="Polly.Joanna">Again. ${say}</Say></Response>`;
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const results = await Promise.all(to.map(async (num) => {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: num, From: env.TWILIO_FROM, Twiml: twiml }),
    });
    return res.ok ? "placed" : `failed HTTP ${res.status}`;
  }));
  return `${results.filter((r) => r === "placed").length} of ${to.length} placed`;
}

async function notify({ subject, text, spoken }) {
  const out = {};
  const jobs = [
    slack(`*${subject}*\n${text}`).then((r) => (out.slack = r)),
    email(subject, text).then((r) => (out.email = r)),
  ];
  if (spoken) jobs.push(call(spoken).then((r) => (out.call = r)));
  await Promise.all(jobs.map((j) => j.catch((e) => console.log("channel error:", e.message))));
  console.log("Notified:", JSON.stringify(out));
  const delivered = Object.values(out).some((r) => /^(sent|placed|[1-9]\d* of)/.test(r));
  if (!delivered) {
    // Failing the run makes GitHub email the repo owner: one more channel.
    console.error("No channel delivered the alert.");
    process.exitCode = 1;
  }
  return out;
}

const fmtList = (fails) => fails.map((f) => `- ${f.name}: ${f.reason}`).join("\n");
const minutesSince = (iso) => Math.round((Date.now() - new Date(iso).getTime()) / 60000);
const howToFix = [
  "What to check:",
  `1. Supabase health: ${SUPABASE_DASH} (if the database shows unhealthy: Project Settings, General, Restart project)`,
  "2. Supabase status page: https://status.supabase.com",
  "3. Or ask Claude: \"Dibs is down, check and fix it\"",
].join("\n");

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  if (TEST) {
    const r = await notify({
      subject: "TEST: Dibs alert check",
      text: "This is a test of the Dibs outage alarm. Nothing is down.\nIf Dibs ever stops working, you will get this kind of message by email, on Slack and as a phone call within about 10 minutes.",
      spoken: "This is a test of the Dibs alarm. Nothing is down. If Dibs stops working, you will get a call like this one.",
    });
    console.log("Test result:", JSON.stringify(r));
    return;
  }

  const fails = await runChecks();
  const open = await openOutage();
  const critical = fails.some((f) => f.critical);

  if (fails.length && !open) {
    const subject = critical ? "DIBS IS DOWN: forms are not loading" : "Dibs problem: part of the site is not answering";
    const text = `${subject}.\n\nFailing now:\n${fmtList(fails)}\n\n${howToFix}`;
    const issue = await gh("/issues", { method: "POST", body: JSON.stringify({ title: `${subject} (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`, body: `${text}\n\n<!-- calls:${critical ? 1 : 0} -->`, labels: ["outage"] }) });
    await notify({ subject, text: `${text}\n\nOutage record: ${issue.html_url}`, spoken: critical ? "Dibs alert. Dibs is down. Forms are not loading on customer websites. Check your email or Slack now." : null });
    return;
  }

  if (fails.length && open) {
    const list = await comments(open.number);
    const last = list.length ? list[list.length - 1].created_at : open.created_at;
    if (minutesSince(last) < REMIND_MIN) { console.log(`Still down, last notice ${minutesSince(last)} min ago.`); return; }
    const calls = (open.body.match(/calls:(\d+)/) ? Number(open.body.match(/calls:(\d+)/)[1]) : 0) + list.filter((c) => c.body.includes("[called]")).length;
    const doCall = critical && calls < MAX_CALLS;
    const subject = `STILL DOWN for ${minutesSince(open.created_at)} min: Dibs`;
    const text = `${subject}.\n\nFailing now:\n${fmtList(fails)}\n\n${howToFix}\n\nOutage record: ${open.html_url}`;
    await notify({ subject, text, spoken: doCall ? `Dibs alert. Dibs has been down for ${minutesSince(open.created_at)} minutes. Forms are not loading.` : null });
    await gh(`/issues/${open.number}/comments`, { method: "POST", body: JSON.stringify({ body: `Reminder sent${doCall ? " [called]" : ""}.\n\n${fmtList(fails)}` }) });
    return;
  }

  if (!fails.length && open) {
    const mins = minutesSince(open.created_at);
    const subject = `Dibs is back up (down about ${mins} min)`;
    await notify({ subject, text: `${subject}. All checks pass again.\n\nOutage record: ${open.html_url}` });
    await gh(`/issues/${open.number}/comments`, { method: "POST", body: JSON.stringify({ body: `Back up. All checks pass. Down about ${mins} minutes.` }) });
    await gh(`/issues/${open.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    return;
  }

  console.log("All checks pass.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
