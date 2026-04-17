/**
 * Vitest suite for the Multica approval workflow.
 *
 * Covers the 5 unit tests specified in Session 18 Wave 3:
 *   1. Code Reviewer loads as read-only with empty required list
 *   2. CEO Agent required list includes an external-email rule
 *   3. Code Reviewer always classifies as 'auto' regardless of actionType
 *   4. Content Writer publishing to live site classifies as 'required'
 *   5. requestApproval resolves to 'rejected' when the 1h timeout elapses
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'multica-approval-'));
const agentsDir = join(tmpRoot, 'agents');
const approvalsDir = join(tmpRoot, 'approvals');
mkdirSync(agentsDir, { recursive: true });
mkdirSync(approvalsDir, { recursive: true });

// Real text pulled from the corresponding ~/lynxd-multica/agents/*.md files
// so classification exercises the actual rule phrasing.
const codeReviewerMd = `---
name: Code Reviewer
runtime: claude-code-acp
model: claude-sonnet-4-6
read_only: true
approval_required: []
auto_approved:
  - read any repo file, draft, or artifact
  - run the anti-slop scanner against any text
  - post audit findings as a Multica board comment
---

# Code Reviewer
Read-only adversarial auditor.
`;

const ceoAgentMd = `---
name: CEO Agent
runtime: claude-code-acp
model: claude-opus-4-7
approval_required:
  - send any external email to a client, prospect, or supplier
  - commit financial decisions (invoices, payments, refunds, budget allocation)
  - hire, fire, retire, or reconfigure another agent
  - change Ceember calendar entries (create, move, cancel events)
  - publish anything to a client-facing surface
  - bulk reassignments that touch more than five agents in one call
auto_approved:
  - assign a task to another agent on the Multica board
  - post an internal status update or briefing
  - read any lynxd_ or report_ table for business state
---

# CEO Agent
`;

const contentWriterMd = `---
name: Content Writer
runtime: claude-code-acp
model: claude-opus-4-7
approval_required:
  - publish to live website or CMS
  - send external email to client or prospect
  - post to social media account
  - push copy into production landing page
  - commit to client-facing repo branches
auto_approved:
  - draft blog post
  - draft landing page copy
  - internal peer review of own output
  - competitor content research
---

# Content Writer
`;

writeFileSync(join(agentsDir, 'code-reviewer.md'), codeReviewerMd);
writeFileSync(join(agentsDir, 'ceo-agent.md'), ceoAgentMd);
writeFileSync(join(agentsDir, 'content-writer.md'), contentWriterMd);

beforeAll(() => {
  process.env.MULTICA_AGENTS_DIR = agentsDir;
  process.env.MULTICA_APPROVALS_DIR = approvalsDir;
  process.env.MULTICA_APPROVAL_SKIP_TELEGRAM = '1';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadAgentApprovalRules', () => {
  it('returns readOnly:true and empty required for code-reviewer', async () => {
    const { loadAgentApprovalRules } = await import('./approval');
    const rules = loadAgentApprovalRules('code-reviewer');
    expect(rules.readOnly).toBe(true);
    expect(rules.required).toEqual([]);
    expect(rules.auto.length).toBeGreaterThan(0);
  });

  it('returns a required list containing an external-email rule for ceo-agent', async () => {
    const { loadAgentApprovalRules } = await import('./approval');
    const rules = loadAgentApprovalRules('ceo-agent');
    expect(rules.readOnly).toBe(false);
    const joined = rules.required.join(' | ').toLowerCase();
    expect(joined).toMatch(/external email/);
    expect(joined).toMatch(/financial|invoice|budget/);
  });
});

describe('classifyAction', () => {
  it('always returns auto for the read-only code-reviewer, even for destructive-sounding actions', async () => {
    const { classifyAction } = await import('./approval');
    expect(classifyAction('code-reviewer', 'delete_production_db')).toBe('auto');
    expect(classifyAction('code-reviewer', 'publish_live_blog_post')).toBe('auto');
    expect(classifyAction('code-reviewer', 'send_client_email')).toBe('auto');
  });

  it('classifies publish_to_live_site as required for content-writer', async () => {
    const { classifyAction } = await import('./approval');
    expect(classifyAction('content-writer', 'publish_to_live_site')).toBe('required');
  });
});

describe('requestApproval timeout', () => {
  it('resolves to rejected with system-timeout when max-wait elapses with no decision', async () => {
    // Behavioral equivalent of the 3600s production timeout. The poll loop
    // interleaves setTimeout (fakeable) with fsp.readFile (real libuv I/O),
    // so vitest fake timers can't drive the loop without stalling on I/O.
    // We shrink MAX_WAIT + POLL to run under real timers, which proves the
    // same branch — start-time vs elapsed >= maxWait → status='rejected',
    // approved_by='system-timeout'.
    const { requestApproval, approveTask } = await import('./approval');
    void approveTask;
    const oldPoll = process.env.MULTICA_APPROVAL_POLL_MS;
    const oldMax = process.env.MULTICA_APPROVAL_MAX_WAIT_MS;
    process.env.MULTICA_APPROVAL_POLL_MS = '25';
    process.env.MULTICA_APPROVAL_MAX_WAIT_MS = '150';

    const task = { task_id: `timeout-${Date.now()}`, agent: 'content-writer' };
    const decision = await requestApproval(task, 'publish to live site');
    expect(decision).toBe('rejected');

    const { readFileSync } = await import('node:fs');
    const record = JSON.parse(readFileSync(join(approvalsDir, `${task.task_id}.json`), 'utf8'));
    expect(record.status).toBe('rejected');
    expect(record.approved_by).toBe('system-timeout');
    expect(record.reason).toMatch(/no decision within/);

    if (oldPoll === undefined) delete process.env.MULTICA_APPROVAL_POLL_MS;
    else process.env.MULTICA_APPROVAL_POLL_MS = oldPoll;
    if (oldMax === undefined) delete process.env.MULTICA_APPROVAL_MAX_WAIT_MS;
    else process.env.MULTICA_APPROVAL_MAX_WAIT_MS = oldMax;
  }, 5_000);
});
