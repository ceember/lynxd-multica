#!/usr/bin/env node
// Multica heartbeat scheduler — Session 18 Wave 3 (Tom).
// launchd invokes this every 15 minutes. Iterates a baked schedule, fires
// any entry whose cron window brackets "now", and enqueues a row into
// lynxd_agent_tasks with metadata.triggered_by='cron'. Idempotent within a
// launch window via a deterministic task_id that encodes the slot.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ENV_PATH = path.join(os.homedir(), 'aios-main', '.env');
const LOG_PATH = '/tmp/lynxd-multica-scheduler.log';
const WINDOW_MINUTES = 15;

const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// report-generator intentionally absent — gated by data-analyst 92% confidence.
const SCHEDULE = [
  { agent: 'ceo-agent',      name: 'daily-sweep',              cron_match: 'daily-06:00',             input: 'Daily 5-step business review' },
  { agent: 'ceo-agent',      name: 'weekly-checkin',           cron_match: 'weekly-MonWedFri-07:00',  input: 'Weekly check-in with Ceember' },
  { agent: 'client-manager', name: 'weekly-client-rotation',   cron_match: 'weekly-Mon-08:00',        input: 'Weekly client rotation check-ins' },
  { agent: 'client-manager', name: 'monthly-report',           cron_match: 'monthly-1-09:00',         input: 'Monthly client report generation' },
  { agent: 'data-analyst',   name: 'confidence-verification',  cron_match: 'daily-05:00',             input: 'Verify data confidence before Report Generator runs' },
];

function loadEnv() {
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  const env = {};
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
  process.stdout.write(line);
}

function parseCron(match) {
  let m = match.match(/^daily-(\d{1,2}):(\d{2})$/);
  if (m) return { kind: 'daily', h: +m[1], min: +m[2] };

  m = match.match(/^weekly-([A-Za-z]+)-(\d{1,2}):(\d{2})$/);
  if (m) {
    const days = [];
    for (let i = 0; i < m[1].length; i += 3) {
      const d = m[1].slice(i, i + 3);
      if (!(d in DAY_MAP)) throw new Error(`bad day '${d}' in '${match}'`);
      days.push(DAY_MAP[d]);
    }
    return { kind: 'weekly', days, h: +m[2], min: +m[3] };
  }

  m = match.match(/^monthly-(\d{1,2})-(\d{1,2}):(\d{2})$/);
  if (m) return { kind: 'monthly', day: +m[1], h: +m[2], min: +m[3] };

  throw new Error(`unrecognised cron_match '${match}'`);
}

function shouldFire(cron, now) {
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setHours(cron.h, cron.min, 0, 0);

  if (target > now) {
    if (cron.kind === 'daily' || cron.kind === 'weekly') target.setDate(target.getDate() - 1);
    else if (cron.kind === 'monthly') target.setMonth(target.getMonth() - 1);
  }

  if (cron.kind === 'weekly' && !cron.days.includes(target.getDay())) return { fire: false };
  if (cron.kind === 'monthly' && target.getDate() !== cron.day) return { fire: false };

  const deltaMs = now - target;
  if (deltaMs < 0) return { fire: false };
  if (deltaMs >= WINDOW_MINUTES * 60 * 1000) return { fire: false };
  return { fire: true, target };
}

function slotKey(t) {
  const pad = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

async function enqueue(env, entry, target, isTest) {
  const slot = slotKey(target);
  const task_id = `cron-${entry.agent}-${entry.name}-${slot}`;

  const metadata = {
    triggered_by: 'cron',
    schedule_name: entry.name,
    scheduled_at: target.toISOString(),
  };
  if (isTest) metadata.test = true;

  const body = {
    task_id,
    agent: entry.agent,
    status: 'pending',
    priority: 'medium',
    input: entry.input,
    approval_status: 'auto',
    metadata,
  };

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/lynxd_agent_tasks`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  // PostgREST with Prefer: resolution=ignore-duplicates always returns 201,
  // but the body is an empty array when the row was silently deduped.
  if (res.status === 201 || res.status === 200) {
    let parsed;
    try { parsed = text ? JSON.parse(text) : []; } catch { parsed = []; }
    if (Array.isArray(parsed) && parsed.length === 0) { log(`SKIP_DUP ${task_id}`); return 'duplicate'; }
    log(`ENQUEUED ${task_id}`);
    return 'inserted';
  }
  if (res.status === 409) { log(`SKIP_DUP ${task_id} (409)`); return 'duplicate'; }
  log(`ERROR ${task_id} HTTP ${res.status} ${text.slice(0, 220)}`);
  return 'error';
}

async function main() {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    log('FATAL: SUPABASE_URL / SUPABASE_SERVICE_KEY missing from env');
    process.exit(1);
  }

  const forceFire = process.argv.includes('--force');
  const now = new Date();
  log(`--- tick @ ${now.toISOString()} (local ${now.toString()})${forceFire ? ' [FORCE]' : ''} ---`);

  let errors = 0;
  let inserted = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const entry of SCHEDULE) {
    let cron;
    try { cron = parseCron(entry.cron_match); }
    catch (e) { log(`PARSE_ERR ${entry.name}: ${e.message}`); errors++; continue; }

    const decision = shouldFire(cron, now);
    let target;

    if (decision.fire) {
      target = decision.target;
    } else if (forceFire) {
      target = new Date(now); target.setSeconds(0, 0);
      log(`FORCE ${entry.agent}/${entry.name} (cron ${entry.cron_match}) → slot ${slotKey(target)}`);
    } else {
      log(`skip ${entry.agent}/${entry.name} — cron ${entry.cron_match} outside window`);
      skipped++;
      continue;
    }

    try {
      const r = await enqueue(env, entry, target, forceFire);
      if (r === 'inserted') inserted++;
      else if (r === 'duplicate') duplicates++;
      else if (r === 'error') errors++;
    } catch (e) {
      log(`EXC ${entry.name}: ${e.message}`);
      errors++;
    }
  }

  log(`summary: inserted=${inserted} duplicates=${duplicates} skipped=${skipped} errors=${errors}`);
  process.exit(errors ? 1 : 0);
}

main().catch(e => { log(`UNCAUGHT ${e.stack || e.message}`); process.exit(1); });
