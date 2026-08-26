// PRIESTATE — Document store & access control (FEATURE 2).
//
// ═══════════════════════════════════════════════════════════════════
// ⚠️  DEMO PERSISTENCE — NOT A PRODUCTION DOCUMENT SERVICE
// ═══════════════════════════════════════════════════════════════════
// This project has no backend, so document METADATA (file name, type,
// size, extraction result) is stored client-side: localStorage keyed by
// the owner's wallet address where available, in-memory otherwise.
//
//   * Raw document contents are never stored or transmitted anywhere.
//     The original file stays on the owner's device for this session.
//   * Nothing here is a security boundary — it demonstrates the access
//     MODEL and keeps documents out of every public surface.
//   * Production requires an encrypted document service with
//     server-side authorization, audit logging, and authenticated
//     retrieval for officers.
// ═══════════════════════════════════════════════════════════════════

import type { UploadedDocumentMeta } from './types';
import { getLatestStatusEvent } from '../data/record-history';
import { getPropertyById } from '../data/mock-properties';

const DOCS_KEY_PREFIX = 'priestate.docs.v1.';
const memoryDocs = new Map<string, UploadedDocumentMeta[]>();

function docsKey(address: string): string {
  return `${DOCS_KEY_PREFIX}${address.trim().toLowerCase()}`;
}

function readStore(address: string): UploadedDocumentMeta[] {
  const key = docsKey(address);
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as UploadedDocumentMeta[]) : [];
  } catch {
    return memoryDocs.get(key) ?? [];
  }
}

function writeStore(address: string, docs: UploadedDocumentMeta[]): void {
  const key = docsKey(address);
  try {
    localStorage.setItem(key, JSON.stringify(docs));
  } catch {
    memoryDocs.set(key, docs);
  }
}

/** All documents owned by a wallet address (private to that user). */
export function getDocumentsForOwner(ownerAddress: string): UploadedDocumentMeta[] {
  if (!ownerAddress.trim()) return [];
  return readStore(ownerAddress);
}

/**
 * Every stored document across all local owners. DEMO ONLY — used by the
 * officer review view, which then filters through canViewDocument /
 * getDocumentsForOfficerReview. Production would replace this with
 * authorized backend queries.
 */
export function getAllStoredDocuments(): UploadedDocumentMeta[] {
  const all = new Map<string, UploadedDocumentMeta>();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DOCS_KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      for (const doc of JSON.parse(raw) as UploadedDocumentMeta[]) all.set(doc.id, doc);
    }
  } catch {
    // localStorage unavailable — fall through to memory below.
  }
  for (const docs of memoryDocs.values()) {
    for (const doc of docs) all.set(doc.id, doc);
  }
  return [...all.values()];
}

export function saveDocumentMeta(meta: UploadedDocumentMeta): void {
  const docs = readStore(meta.ownerAddress);
  const idx = docs.findIndex((d) => d.id === meta.id);
  if (idx >= 0) docs[idx] = meta;
  else docs.push(meta);
  writeStore(meta.ownerAddress, docs);
}

export function deleteDocumentMeta(ownerAddress: string, docId: string): void {
  writeStore(
    ownerAddress,
    readStore(ownerAddress).filter((d) => d.id !== docId),
  );
}

/** Attach an uploaded document to a registration application. */
export function linkDocumentToApplication(ownerAddress: string, docId: string, applicationId: string): void {
  const docs = readStore(ownerAddress);
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return;
  doc.linkedApplicationId = applicationId;
  writeStore(ownerAddress, docs);
}

// ── Access control ──────────────────────────────────────────────────

export interface DocumentViewer {
  address: string;
  isOfficer: boolean;
}

/**
 * Effective application status for review-gating, mirroring the officer
 * portal logic: latest append-only status event wins over seed data.
 */
function isApplicationUnderReview(applicationId: string | undefined): boolean {
  if (!applicationId) return false;
  const property = getPropertyById(applicationId);
  if (!property) return false;
  const latest = getLatestStatusEvent(applicationId);
  if (latest?.type === 'REGISTRATION_APPROVED' || latest?.type === 'REGISTRATION_REJECTED') {
    return false; // Finalized — no longer under active review.
  }
  return property.registrationStatus === 'SUBMITTED' || property.registrationStatus === 'PENDING_REVIEW';
}

/**
 * Who may see a document:
 *   - its OWNER always;
 *   - an OFFICER only while the linked application is actively under
 *     review (documents required for application review).
 * Everyone else — including other normal users — sees nothing.
 */
export function canViewDocument(doc: UploadedDocumentMeta, viewer: DocumentViewer): boolean {
  if (!viewer.address) return false;
  if (doc.ownerAddress.trim().toLowerCase() === viewer.address.trim().toLowerCase()) return true;
  if (viewer.isOfficer && isApplicationUnderReview(doc.linkedApplicationId)) return true;
  return false;
}

/** Filter a list of documents down to what a viewer is allowed to see. */
export function getDocumentsVisibleTo(docs: readonly UploadedDocumentMeta[], viewer: DocumentViewer): UploadedDocumentMeta[] {
  return docs.filter((d) => canViewDocument(d, viewer));
}

/** Documents an OFFICER may access for one application under review. */
export function getDocumentsForOfficerReview(
  applicationId: string,
  allDocs: readonly UploadedDocumentMeta[],
): UploadedDocumentMeta[] {
  if (!isApplicationUnderReview(applicationId)) return [];
  return allDocs.filter((d) => d.linkedApplicationId === applicationId);
}
