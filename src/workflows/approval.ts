/**
 * Multica approval workflow.
 *
 * Pauses risky agent actions until a human (Ceember) approves or rejects
 * via the Multica UI or a direct `approveTask` call. Approval state is
 * persisted in `~/.multica/approvals/<task_id>.json` and mirrored to
 * Supabase `lynxd_agent_tasks.approval_status`. A Telegram ping is fired
 * to Lucy's channel when a pending approval is created. Read-only agents
 * (e.g. Code Reviewer) bypass the queue — they cannot take risky actions
 * by design.
 */

import { existsSync, mkdirSync, promises as fsp, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const HOME = homedir();
const getAgentsDir = (): string =>
  process.env.MULTICA_AGENTS_DIR || join(HOME, 'lynxd-multica', 'agents');
const getApprovalsDir = (): string =>
  process.env.MULTICA_APPROVALS_DIR || join(HOME, '.multica', 'approvals');
const getPollMs = (): number => Number(process.env.MULTICA_APPROVAL_POLL_MS || 5_000);
const getMaxWaitMs = (): number => Number(process.env.MULTICA_APPROVAL_MAX_WAIT_MS || 3_600_000);

export interface AgentApprovalRules {
  auto: string[];
  required: string[];
  readOnly: boolean;
}

export interface Task {
  task_id: string;
  agent: string;
  input?: string;
  approval_status?: string;
  [k: string]: unknown;
}

export type ClassifyResult = 'auto' | 'required' | 'unknown';
export type Decision = 'approved' | 'rejected';

interface ApprovalFile {
  task_id: string;
  agent: string;
  action_description: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  decided_at: string | null;
  approved_by: string | null;
  reason: string | null;
}

function parseFrontmatter(md: string): Record<string, unknown> {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return {};
  const parsed = yaml.load(m[1]);
  return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
}

export function loadAgentApprovalRules(agentName: string): AgentApprovalRules {
  const path = join(getAgentsDir(), `${agentName}.md`);
  const md = readFileSync(path, 'utf8');
  const fm = parseFrontmatter(md);
  const readOnly = fm.read_only === true;
  const auto = Array.isArray(fm.auto_approved) ? (fm.auto_approved as unknown[]).map(String) : [];
  const requiredRaw = Array.isArray(fm.approval_required)
    ? (fm.approval_required as unknown[]).map(String)
    : [];
  return { auto, required: readOnly ? [] : requiredRaw, readOnly };
}

const STOPWORDS = new Set([
  'a','an','the','to','or','and','any','of','on','in','for','with','at','by','from','as','is',
  'it','be','that','this','these','those','so','not','no','than','via','into','out','over','up',
]);

function contentTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function ruleMatches(actionType: string, rule: string): boolean {
  const at = contentTokens(actionType);
  const rt = contentTokens(rule);
  if (at.size === 0 || rt.size === 0) return false;
  let overlap = 0;
  for (const t of at) if (rt.has(t)) overlap++;
  return overlap >= 2;
}

export function classifyAction(agent: string, actionType: string): ClassifyResult {
  const rules = loadAgentApprovalRules(agent);
  if (rules.readOnly) return 'auto';
  for (const rule of rules.required) if (ruleMatches(actionType, rule)) return 'required';
  for (const rule of rules.auto) if (ruleMatches(actionType, rule)) return 'auto';
  return 'unknown';
}

function ensureApprovalsDir(): string {
  const dir = getApprovalsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function approvalPath(taskId: string): string {
  return join(ensureApprovalsDir(), `${taskId}.json`);
}

async function writeApprovalFile(data: ApprovalFile): Promise<void> {
  await fsp.writeFile(approvalPath(data.task_id), JSON.stringify(data, null, 2), 'utf8');
}

async function readApprovalFile(taskId: string): Promise<ApprovalFile | null> {
  try {
    const raw = await fsp.readFile(approvalPath(taskId), 'utf8');
    return JSON.parse(raw) as ApprovalFile;
  } catch {
    return null;
  }
}

async function updateSupabaseTaskStatus(
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    const endpoint = `${url.replace(/\/$/, '')}/rest/v1/lynxd_agent_tasks?task_id=eq.${encodeURIComponent(
      taskId,
    )}`;
    const res = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[approval] Supabase PATCH ${res.status} for ${taskId}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[approval] Supabase update failed for ${taskId}: ${(err as Error).message}`);
  }
}

async function sendTelegramPing(task: Task, action: string, taskId: string): Promise<void> {
  if (process.env.MULTICA_APPROVAL_SKIP_TELEGRAM === '1') return;
  const py = process.env.MULTICA_PYTHON || join(HOME, 'aios-main', '.venv', 'bin', 'python');
  const aios = process.env.MULTICA_AIOS_ROOT || join(HOME, 'aios-main');
  const msg = `Approval requested for ${task.agent} task ${taskId}: ${action}. Open Multica to approve or reject.`;
  const code = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(aios)})`,
    'from scripts.shared.telegram_utils import send_alert',
    `send_alert("WARNING", "multica-approval", ${JSON.stringify(msg)})`,
  ].join('\n');
  await new Promise<void>((resolve) => {
    const child = execFile(py, ['-c', code], { timeout: 15_000 }, (err) => {
      if (err) console.warn(`[approval] Telegram ping failed: ${err.message}`);
      resolve();
    });
    child.on('error', (err) => {
      console.warn(`[approval] Telegram spawn failed: ${err.message}`);
      resolve();
    });
  });
}

export async function requestApproval(task: Task, actionDescription: string): Promise<Decision> {
  const taskId = task.task_id;
  const nowIso = (): string => new Date().toISOString();

  const initial: ApprovalFile = {
    task_id: taskId,
    agent: task.agent,
    action_description: actionDescription,
    status: 'pending',
    requested_at: nowIso(),
    decided_at: null,
    approved_by: null,
    reason: null,
  };
  await writeApprovalFile(initial);
  await updateSupabaseTaskStatus(taskId, {
    approval_status: 'pending',
    updated_at: initial.requested_at,
  });
  sendTelegramPing(task, actionDescription, taskId).catch(() => {});

  const start = Date.now();
  const pollMs = getPollMs();
  const maxWaitMs = getMaxWaitMs();

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= maxWaitMs) {
      const decidedAt = nowIso();
      const final: ApprovalFile = {
        ...initial,
        status: 'rejected',
        decided_at: decidedAt,
        approved_by: 'system-timeout',
        reason: `no decision within ${Math.round(maxWaitMs / 1000)}s`,
      };
      await writeApprovalFile(final);
      await updateSupabaseTaskStatus(taskId, {
        approval_status: 'rejected',
        approved_by: 'system-timeout',
        approved_at: decidedAt,
        updated_at: decidedAt,
      });
      return 'rejected';
    }

    const current = await readApprovalFile(taskId);
    if (current && current.status !== 'pending') {
      await updateSupabaseTaskStatus(taskId, {
        approval_status: current.status,
        approved_by: current.approved_by,
        approved_at: current.decided_at,
        updated_at: nowIso(),
      });
      return current.status;
    }

    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

export async function approveTask(
  taskId: string,
  approver: string,
  decision: Decision,
  reason?: string,
): Promise<void> {
  const existing = await readApprovalFile(taskId);
  if (!existing) {
    throw new Error(`Approval request not found for task ${taskId}`);
  }
  const decidedAt = new Date().toISOString();
  const updated: ApprovalFile = {
    ...existing,
    status: decision,
    decided_at: decidedAt,
    approved_by: approver,
    reason: reason ?? null,
  };
  await writeApprovalFile(updated);
  await updateSupabaseTaskStatus(taskId, {
    approval_status: decision,
    approved_by: approver,
    approved_at: decidedAt,
    updated_at: decidedAt,
  });
}
