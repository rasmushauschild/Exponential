#!/usr/bin/env node
/**
 * Exponential MCP server — lets Claude work with your Exponential plan.
 *
 * Auth: piggybacks on the Exponential desktop app. The first run exchanges the app's Google
 * id_token for a Supabase session; after that the session refreshes itself independently and is
 * kept in the app's data folder. Everything runs under your own account and row-level security —
 * Claude can only see and touch what you can.
 *
 * The master plan (projects, deadlines, groups) is read-only for Claude unless the plan is
 * unlocked in the app (the padlock button); week/task work is always allowed.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SUPABASE_URL = 'https://mojqfsnnawdxndqaciuv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SwEXVchPqA2ohG3jUzUMKA_Ijo88XVJ';

/* ── where the desktop app keeps its state ── */
const dataDir = process.env.EXPONENTIAL_DATA_DIR ?? {
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Exponential'),
  win32: path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Exponential'),
  linux: path.join(os.homedir(), '.config', 'Exponential'),
}[process.platform];

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sharedState = () => readJson(path.join(dataDir, 'shared-state.json')) ?? {};

/* ── supabase session, persisted next to the app's data ── */
const sessionFile = path.join(dataDir, 'mcp-session.json');
const storage = {
  getItem: (k) => readJson(sessionFile)?.[k] ?? null,
  setItem: (k, v) => { const cur = readJson(sessionFile) ?? {}; cur[k] = v; fs.writeFileSync(sessionFile, JSON.stringify(cur)); },
  removeItem: (k) => { const cur = readJson(sessionFile) ?? {}; delete cur[k]; fs.writeFileSync(sessionFile, JSON.stringify(cur)); },
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage, storageKey: 'exponential-mcp' },
});

async function ensureAuth() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;
  const tokens = readJson(path.join(dataDir, 'google-tokens.json'));
  if (!tokens?.id_token) throw new Error('Not signed in. Open the Exponential app and sign in with Google first.');
  const { data: signed, error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: tokens.id_token });
  if (error) throw new Error(`Couldn't start a session (${error.message}). Open the Exponential app once so it refreshes your Google sign-in, then try again.`);
  return signed.session.user.id;
}

/* ── helpers ── */
const uid = () => crypto.randomUUID();
const iso = (d) => d.toISOString().slice(0, 10);
const dayIndex = (isoDate) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
const fromDayIndex = (n) => iso(new Date(n * 86_400_000));
const addDays = (isoDate, n) => fromDayIndex(dayIndex(isoDate) + n);
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const weekStart = (isoDate) => { const n = dayIndex(isoDate); return fromDayIndex(n - ((n + 3) % 7)); }; // Monday

const die = (msg) => { throw new Error(msg); };
const q = async (query) => { const { data, error } = await query; if (error) die(error.message); return data; };

async function currentTeam() {
  const teams = await q(supabase.from('teams').select('id, name').order('created_at'));
  if (!teams.length) die('You are not in any team yet.');
  const wanted = sharedState().teamId;
  return teams.find((t) => t.id === wanted) ?? teams[0];
}

async function teamPeople(teamId) {
  const members = await q(supabase.from('team_members').select('email, user_id, role').eq('team_id', teamId));
  const ids = members.map((m) => m.user_id).filter(Boolean);
  const profiles = ids.length ? await q(supabase.from('profiles').select('id, email, name').in('id', ids)) : [];
  return members.map((m) => {
    const p = profiles.find((x) => x.id === m.user_id);
    return { id: m.user_id, email: m.email, name: p?.name ?? m.email, role: m.role, pending: !m.user_id };
  });
}

async function resolvePerson(teamId, me, ref) {
  if (!ref || /^me$/i.test(ref)) return { id: me, name: 'me' };
  const people = await teamPeople(teamId);
  const needle = ref.toLowerCase();
  const hit = people.find((p) => p.id === ref)
    ?? people.find((p) => p.email?.toLowerCase() === needle)
    ?? people.find((p) => p.name?.toLowerCase() === needle)
    ?? people.find((p) => p.name?.toLowerCase().startsWith(needle))
    ?? people.find((p) => p.name?.toLowerCase().includes(needle));
  if (!hit) die(`No team member matches "${ref}". People: ${people.map((p) => p.name).join(', ')}`);
  if (hit.pending) die(`${hit.email} was invited but hasn't signed in yet, so they can't own tasks.`);
  return hit;
}

async function myName(me) {
  const rows = await q(supabase.from('profiles').select('name').eq('id', me));
  const full = rows[0]?.name ?? 'Someone';
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : full;
}

async function notify(teamId, me, toUser, kind, text, refKind, refId) {
  if (!toUser || toUser === me) return;
  await q(supabase.from('notifications').insert({ id: uid(), team_id: teamId, to_user: toUser, from_user: me, kind, text, ref_kind: refKind, ref_id: refId }));
}

function requireUnlocked() {
  if (!sharedState().planUnlocked) {
    die('The master plan is locked. Ask the user to click "Unlock" in Exponential (top right of the Master plan) and try again while it stays unlocked.');
  }
}

const STATUSES = ['todo', 'progress', 'review', 'done', 'cancelled'];
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });

const taskOut = (t, people) => ({
  id: t.id,
  title: t.title,
  owner: people.find((p) => p.id === t.person_id)?.name ?? (t.person_id ? t.person_id : 'unassigned'),
  date: t.date ?? 'backlog',
  end: t.end_date ?? undefined,
  status: t.status,
  reviewer: t.reviewer_id ? people.find((p) => p.id === t.reviewer_id)?.name : undefined,
  review_done: t.review_done || undefined,
  project_id: t.project_id ?? undefined,
  parent_id: t.parent_id ?? undefined,
  notes: t.notes || undefined,
});

/* ── the server ── */
const server = new McpServer({ name: 'exponential', version: '0.1.0' });

const tool = (name, description, schema, handler) => {
  server.tool(name, description, schema, async (args) => {
    try {
      const me = await ensureAuth();
      return await handler(args ?? {}, me);
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
};

tool('get_overview',
  'The whole team plan at a glance: people, groups, projects (with dates), deadlines, and task counts. Start here.',
  {},
  async (_a, me) => {
    const team = await currentTeam();
    const people = await teamPeople(team.id);
    const [projects, deadlines, groups, tasks] = await Promise.all([
      q(supabase.from('projects').select('*').eq('team_id', team.id).is('deleted_at', null)),
      q(supabase.from('deadlines').select('*').eq('team_id', team.id).order('date')),
      q(supabase.from('groups').select('*').eq('team_id', team.id).order('sort')),
      q(supabase.from('tasks').select('id, person_id, status, date').eq('team_id', team.id).is('deleted_at', null)),
    ]);
    return text({
      team: team.name,
      today: todayISO(),
      current_week_monday: weekStart(todayISO()),
      plan_unlocked: !!sharedState().planUnlocked,
      me: people.find((p) => p.id === me)?.name,
      people: people.map((p) => ({ name: p.name, email: p.email, role: p.role, pending: p.pending || undefined })),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      projects: projects.map((p) => ({ id: p.id, name: p.name, start: p.start_date, end: p.end_date, group: groups.find((g) => g.id === p.group_id)?.name })),
      deadlines: deadlines.map((d) => ({ id: d.id, name: d.name, date: d.date })),
      open_tasks_per_person: Object.fromEntries(people.filter((p) => !p.pending).map((p) => [p.name, tasks.filter((t) => t.person_id === p.id && !['done', 'cancelled'].includes(t.status)).length])),
    });
  });

tool('get_week',
  "A person's week: scheduled tasks plus their backlog (undated tasks shown every week). week_offset 0 = current week, 1 = next, -1 = last.",
  { person: z.string().optional().describe('Name or email; defaults to the signed-in user'), week_offset: z.number().int().optional() },
  async (a, me) => {
    const team = await currentTeam();
    const who = await resolvePerson(team.id, me, a.person);
    const people = await teamPeople(team.id);
    const monday = addDays(weekStart(todayISO()), (a.week_offset ?? 0) * 7);
    const sunday = addDays(monday, 6);
    const rows = await q(supabase.from('tasks').select('*').eq('team_id', team.id).is('deleted_at', null));
    const mine = rows.filter((t) => t.person_id === who.id || (t.reviewer_id === who.id && (t.status === 'review' || t.review_done)));
    const inWeek = mine.filter((t) => t.date && t.date <= sunday && (t.end_date ?? t.date) >= monday);
    const backlog = mine.filter((t) => !t.date);
    return text({
      person: who.name, week_monday: monday,
      tasks: inWeek.sort((x, y) => (x.date < y.date ? -1 : 1)).map((t) => taskOut(t, people)),
      backlog: backlog.map((t) => taskOut(t, people)),
    });
  });

tool('get_item',
  'Full detail of one project, task, or deadline by id: fields, notes (Markdown), and linked tasks/subtasks.',
  { id: z.string() },
  async (a) => {
    const team = await currentTeam();
    const people = await teamPeople(team.id);
    const [p] = await q(supabase.from('projects').select('*').eq('id', a.id));
    if (p) {
      const linked = await q(supabase.from('tasks').select('*').eq('project_id', p.id).is('deleted_at', null));
      return text({ kind: 'project', id: p.id, name: p.name, start: p.start_date, end: p.end_date, notes: p.notes || undefined, deleted: !!p.deleted_at || undefined, tasks: linked.map((t) => taskOut(t, people)) });
    }
    const [t] = await q(supabase.from('tasks').select('*').eq('id', a.id));
    if (t) {
      const subs = await q(supabase.from('tasks').select('*').eq('parent_id', t.id).is('deleted_at', null));
      return text({ kind: 'task', ...taskOut(t, people), deleted: !!t.deleted_at || undefined, subtasks: subs.map((s) => taskOut(s, people)) });
    }
    const [d] = await q(supabase.from('deadlines').select('*').eq('id', a.id));
    if (d) return text({ kind: 'deadline', id: d.id, name: d.name, date: d.date, notes: d.notes || undefined });
    die(`Nothing found with id ${a.id}`);
  });

tool('search',
  'Find projects, tasks, and deadlines whose title or notes match a query (case-insensitive substring).',
  { query: z.string() },
  async (a) => {
    const team = await currentTeam();
    const people = await teamPeople(team.id);
    const needle = `%${a.query}%`;
    const [projects, tasks, deadlines] = await Promise.all([
      q(supabase.from('projects').select('id, name, start_date, end_date, notes').eq('team_id', team.id).is('deleted_at', null).or(`name.ilike.${needle},notes.ilike.${needle}`)),
      q(supabase.from('tasks').select('*').eq('team_id', team.id).is('deleted_at', null).or(`title.ilike.${needle},notes.ilike.${needle}`)),
      q(supabase.from('deadlines').select('id, name, date').eq('team_id', team.id).ilike('name', needle)),
    ]);
    return text({
      projects: projects.map((p) => ({ id: p.id, name: p.name, start: p.start_date, end: p.end_date })),
      tasks: tasks.map((t) => taskOut(t, people)),
      deadlines,
    });
  });

tool('get_retro',
  "A week's retro answers. week_offset 0 = current week, -1 = last week.",
  { week_offset: z.number().int().optional() },
  async (a) => {
    const team = await currentTeam();
    const monday = addDays(weekStart(todayISO()), (a.week_offset ?? 0) * 7);
    const rows = await q(supabase.from('retros').select('*').eq('team_id', team.id).eq('week', monday));
    return text(rows[0] ? { week: monday, answers: rows[0].answers, notes: rows[0].notes || undefined } : { week: monday, answers: {}, note: 'No retro written for this week yet.' });
  });

tool('create_task',
  'Add a task. Defaults to my backlog; give a date (YYYY-MM-DD) to schedule it, a person to assign it, project_id to put it on a project.',
  {
    title: z.string(),
    person: z.string().optional().describe('Name/email, "me", or omit for me; the person is notified when it is not you'),
    date: z.string().optional(), end: z.string().optional(),
    project_id: z.string().optional(), parent_task_id: z.string().optional(),
    unassigned: z.boolean().optional().describe('true: leave it on the project/parent with no owner'),
  },
  async (a, me) => {
    const team = await currentTeam();
    const personId = a.unassigned ? null : (await resolvePerson(team.id, me, a.person)).id;
    const peers = await q(supabase.from('tasks').select('sort_order').eq('team_id', team.id).is('deleted_at', null)
      .filter('person_id', personId ? 'eq' : 'is', personId).filter('date', a.date ? 'eq' : 'is', a.date ?? null));
    const order = peers.reduce((m, t) => Math.max(m, (t.sort_order ?? 0) + 1), 0);
    const id = uid();
    await q(supabase.from('tasks').insert({
      id, team_id: team.id, person_id: personId, title: a.title, date: a.date ?? null, end_date: a.end ?? null,
      status: 'todo', sort_order: order, created_by: me, project_id: a.project_id ?? null, parent_id: a.parent_task_id ?? null,
    }));
    if (personId && personId !== me) await notify(team.id, me, personId, 'task-added', `${await myName(me)} added “${a.title}” to your ${a.date ? 'week' : 'backlog'}`, 'task', id);
    return text({ created: id });
  });

tool('update_task',
  'Change a task: title, status (todo|progress|review|done|cancelled), dates (date/end, "backlog" clears), owner, reviewer (with status review = request a review; the people involved are notified).',
  {
    id: z.string(), title: z.string().optional(), status: z.enum(STATUSES).optional(),
    date: z.string().optional().describe('YYYY-MM-DD, or "backlog" to unschedule'), end: z.string().optional(),
    person: z.string().optional().describe('New owner (name/email/"me")'),
    reviewer: z.string().optional().describe('With status "review": who to ask for the review'),
  },
  async (a, me) => {
    const team = await currentTeam();
    const [before] = await q(supabase.from('tasks').select('*').eq('id', a.id));
    if (!before) die(`No task ${a.id}`);
    const patch = {};
    if (a.title !== undefined) patch.title = a.title;
    if (a.status !== undefined) patch.status = a.status;
    if (a.date !== undefined) patch.date = a.date === 'backlog' ? null : a.date;
    if (a.end !== undefined) patch.end_date = a.end || null;
    if (a.person !== undefined) patch.person_id = (await resolvePerson(team.id, me, a.person)).id;
    if (a.reviewer !== undefined) patch.reviewer_id = (await resolvePerson(team.id, me, a.reviewer)).id;
    const after = { ...before, ...patch };
    if (after.status === 'review' && after.reviewer_id && (after.reviewer_id !== before.reviewer_id || before.status !== 'review')) patch.review_done = false;
    await q(supabase.from('tasks').update(patch).eq('id', a.id));
    const name = await myName(me);
    if (patch.person_id && patch.person_id !== before.person_id) {
      await notify(team.id, me, patch.person_id, 'owner-changed', `${name} handed you “${after.title}”`, 'task', a.id);
      if (before.person_id) await notify(team.id, me, before.person_id, 'owner-changed', `${name} moved “${after.title}” to someone else`, 'task', a.id);
    }
    if (after.status === 'review' && after.reviewer_id && (after.reviewer_id !== before.reviewer_id || before.status !== 'review')) {
      await notify(team.id, me, after.reviewer_id, 'review-requested', `${name} asked you to review “${after.title}”`, 'task', a.id);
    }
    return text({ updated: a.id });
  });

tool('delete_task',
  'Delete a task (soft: it sits in Team settings → Recently deleted for 7 days).',
  { id: z.string() },
  async (a) => {
    await q(supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', a.id));
    return text({ deleted: a.id, note: 'Recoverable for 7 days in Team settings → Recently deleted.' });
  });

tool('set_notes',
  'Replace the Markdown notes of a project, task, or deadline. Task lines use "- [ ] Title <!--task:uuid-->" and must keep their comment markers.',
  { kind: z.enum(['project', 'task', 'deadline']), id: z.string(), markdown: z.string() },
  async (a) => {
    const table = a.kind === 'project' ? 'projects' : a.kind === 'task' ? 'tasks' : 'deadlines';
    await q(supabase.from(table).update({ notes: a.markdown }).eq('id', a.id));
    return text({ updated: a.id });
  });

/* ── master plan: only while the user has it unlocked in the app ── */

tool('create_project',
  'Create a project bar on the master plan. Requires the plan to be unlocked in the app.',
  { name: z.string(), start: z.string().describe('YYYY-MM-DD'), end: z.string(), group: z.string().optional().describe('Group name') },
  async (a, me) => {
    requireUnlocked();
    const team = await currentTeam();
    let groupId = null;
    if (a.group) {
      const groups = await q(supabase.from('groups').select('id, name').eq('team_id', team.id));
      groupId = groups.find((g) => g.name.toLowerCase() === a.group.toLowerCase())?.id ?? die(`No group called "${a.group}"`);
    }
    const peers = await q(supabase.from('projects').select('lane, group_id').eq('team_id', team.id).is('deleted_at', null));
    const lane = peers.filter((p) => (p.group_id ?? null) === groupId).reduce((m, p) => Math.max(m, p.lane + 1), 0);
    const id = uid();
    await q(supabase.from('projects').insert({ id, team_id: team.id, name: a.name, start_date: a.start, end_date: a.end, lane, group_id: groupId, created_by: undefined }));
    return text({ created: id });
  });

tool('update_project',
  'Move/rename a project or change its group. Requires the plan to be unlocked in the app.',
  { id: z.string(), name: z.string().optional(), start: z.string().optional(), end: z.string().optional(), group: z.string().optional().describe('Group name, or "" for no group') },
  async (a) => {
    requireUnlocked();
    const team = await currentTeam();
    const patch = {};
    if (a.name !== undefined) patch.name = a.name;
    if (a.start !== undefined) patch.start_date = a.start;
    if (a.end !== undefined) patch.end_date = a.end;
    if (a.group !== undefined) {
      if (a.group === '') patch.group_id = null;
      else {
        const groups = await q(supabase.from('groups').select('id, name').eq('team_id', team.id));
        patch.group_id = groups.find((g) => g.name.toLowerCase() === a.group.toLowerCase())?.id ?? die(`No group called "${a.group}"`);
      }
    }
    await q(supabase.from('projects').update(patch).eq('id', a.id));
    return text({ updated: a.id });
  });

tool('delete_project',
  'Delete a project (soft: recoverable for 7 days). Requires the plan to be unlocked in the app.',
  { id: z.string() },
  async (a) => {
    requireUnlocked();
    await q(supabase.from('projects').update({ deleted_at: new Date().toISOString() }).eq('id', a.id));
    return text({ deleted: a.id, note: 'Recoverable for 7 days in Team settings → Recently deleted.' });
  });

tool('create_deadline',
  'Add a deadline dot to the master plan. Requires the plan to be unlocked in the app.',
  { name: z.string(), date: z.string().describe('YYYY-MM-DD') },
  async (a) => {
    requireUnlocked();
    const team = await currentTeam();
    const id = uid();
    await q(supabase.from('deadlines').insert({ id, team_id: team.id, name: a.name, date: a.date }));
    return text({ created: id });
  });

tool('update_deadline',
  'Rename or move a deadline. Requires the plan to be unlocked in the app.',
  { id: z.string(), name: z.string().optional(), date: z.string().optional() },
  async (a) => {
    requireUnlocked();
    const patch = {};
    if (a.name !== undefined) patch.name = a.name;
    if (a.date !== undefined) patch.date = a.date;
    await q(supabase.from('deadlines').update(patch).eq('id', a.id));
    return text({ updated: a.id });
  });

tool('delete_deadline',
  'Remove a deadline. Requires the plan to be unlocked in the app.',
  { id: z.string() },
  async (a) => {
    requireUnlocked();
    await q(supabase.from('deadlines').delete().eq('id', a.id));
    return text({ deleted: a.id });
  });

tool('create_group',
  'Create a project group (a coloured section on the master plan). Requires the plan to be unlocked in the app.',
  { name: z.string(), color: z.string().optional().describe('Hex colour, e.g. #5b8def') },
  async (a) => {
    requireUnlocked();
    const team = await currentTeam();
    const groups = await q(supabase.from('groups').select('sort').eq('team_id', team.id));
    const id = uid();
    await q(supabase.from('groups').insert({ id, team_id: team.id, name: a.name, color: a.color ?? '#5b8def', sort: groups.reduce((m, g) => Math.max(m, g.sort + 1), 0) }));
    return text({ created: id });
  });

const transport = new StdioServerTransport();
await server.connect(transport);
