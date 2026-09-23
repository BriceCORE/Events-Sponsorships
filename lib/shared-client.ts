import {createClient} from '@supabase/supabase-js';
import type {Data, Organization} from './types';
import {validateReview} from './review';
import {validateWorkspace} from './workspace-file';

// Preview can only be enabled in a development build. No ledger is bundled.
export const localPreview = import.meta.env.DEV && import.meta.env.VITE_LOCAL_PREVIEW === 'true';
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const workspaceId = import.meta.env.VITE_WORKSPACE_ID || 'core-midwest';
export const authLinkType = /type=(invite|recovery)/.test(window.location.hash + window.location.search);
const authFragment = new URLSearchParams(window.location.hash.slice(1));
export const authLinkError = authFragment.get('error') ? (authFragment.get('error_description') || 'This sign-in link is invalid or has expired. Request a new link.') : '';
export const supabase = url && key ? createClient(url, key) : null;
type Snapshot = {data: Data | null; revision: number; role: 'owner' | 'editor' | 'viewer'};
let snapshot: Snapshot | null = null;
let saving = false;
let sessionGeneration = 0;
export const workspaceRevision = () => snapshot?.revision ?? 0;
export const workspaceRole = () => localPreview ? 'owner' : snapshot?.role;
export const canEdit = () => localPreview || ['owner', 'editor'].includes(snapshot?.role || '');
export const clearSnapshot = () => { snapshot = null; saving = false; sessionGeneration++; };
const empty: Data = {organizations: [], payments: [], benefits: [], meta: {source: '', researchAsOf: '', note: ''}};

async function rpc(name: string, args: Record<string, unknown>): Promise<Snapshot> {
  if (!supabase) throw new Error('The shared workspace connection has not been configured.');
  const {data, error} = await supabase.rpc(name, args);
  if (error) {
    if (error.code === 'PT409') throw new Error('The shared workspace changed while you were reviewing. Your draft has not been saved. Close this editor, refresh, and review the latest values before saving again.');
    throw new Error(error.message || 'The shared workspace could not be reached.');
  }
  return data as Snapshot;
}

async function save(data: Data, action = 'save', expectedRevision = snapshot?.revision) {
  if (saving) throw new Error('Another change is still saving. Please try again shortly.');
  if (!snapshot) throw new Error('Refresh the workspace before saving.');
  saving = true;
  const generation = sessionGeneration;
  try {
    const next = await rpc('core_save_workspace', {p_workspace_id: workspaceId, p_payload: validateWorkspace(data), p_expected_revision: expectedRevision, p_action: action});
    if (generation !== sessionGeneration) throw new Error('Your session changed. Sign in again and refresh the workspace.');
    snapshot = next;
    return next.data!;
  } finally { if (generation === sessionGeneration) saving = false; }
}

export async function importSharedWorkspace(value: unknown, expectedRevision: number) {
  if (localPreview) throw new Error('Workspace import is available after connecting the shared database.');
  if (workspaceRole() !== 'owner') throw new Error('Only a workspace owner can import or replace the workspace.');
  return save(validateWorkspace(value), 'import', expectedRevision);
}

export async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  if (localPreview) {
    const response = await fetch(path, {method, headers: {'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'This change could not be saved.');
    return data;
  }
  if (method === 'GET' && path === '/api/workspace') {
    if (saving && snapshot) return snapshot.data || empty;
    const generation = sessionGeneration;
    const next = await rpc('core_get_workspace', {p_workspace_id: workspaceId});
    if (generation !== sessionGeneration) throw new Error('Your session changed. Sign in again and refresh the workspace.');
    // A slow read must not overwrite a newer save in this browser.
    if (!snapshot || next.revision >= snapshot.revision) snapshot = next;
    return snapshot.data || empty;
  }
  if (!canEdit()) throw new Error('Your workspace access is read-only.');
  if (!snapshot?.data) throw new Error('Import the initial workspace before making changes.');
  const data = structuredClone(snapshot.data);
  const input = body as Record<string, any>;
  if (path.startsWith('/api/expenses/') && method === 'PUT') {
    const payment = data.payments.find(p => p.id === decodeURIComponent(path.split('/').pop()!));
    if (!payment) throw new Error('Expense not found.');
    const review = validateReview(input, payment, new Set(data.organizations.map(o => o.id)));
    if (review.revision !== payment.revision) throw new Error('This expense changed. Close the editor and refresh before saving.');
    if (JSON.stringify([review.sector, review.amountCents, review.allocations, review.note, review.reviewed]) === JSON.stringify([payment.sector, payment.amountCents, payment.allocations, payment.note, payment.reviewed])) return {payment};
    Object.assign(payment, review, {revision: payment.revision + 1});
    await save(data);
    return {payment};
  }
  if (path === '/api/organizations' && method === 'POST') {
    const name = String(input.name || '').trim(), sector = String(input.sector || '').trim();
    if (!name || name.length > 200 || !sector || sector.length > 80) throw new Error('Enter an organization name and market sector.');
    if (data.organizations.some(o => o.name.toLowerCase() === name.toLowerCase())) throw new Error('An organization with this name already exists.');
    const organization: Organization = {id: 'org-custom-' + crypto.randomUUID(), name, sector, type: 'Organization', state: '', aliases: [name]};
    data.organizations.push(organization);
    await save(data);
    return {organization};
  }
  if (path.startsWith('/api/benefits/') && method === 'PUT') {
    const benefit = data.benefits.find(b => b.id === decodeURIComponent(path.split('/').pop()!));
    if (!benefit) throw new Error('Benefit not found.');
    if ((benefit.note || '') !== input.expectedNote || (benefit.utilization || 'Not reviewed') !== input.expectedUtilization) throw new Error('This benefit review changed while you were editing. Close the editor and refresh before saving.');
    if (typeof input.note !== 'string' || input.note.length > 4000) throw new Error('Keep the benefit note under 4,000 characters.');
    if (!['Not reviewed', 'Planned', 'Partly used', 'Fully used', 'Not used', 'Needs confirmation'].includes(input.utilization)) throw new Error('Choose a benefit use status.');
    benefit.note = input.note.trim(); benefit.utilization = input.utilization;
    await save(data);
    return {benefit};
  }
  throw new Error('This workspace action is not supported.');
}
