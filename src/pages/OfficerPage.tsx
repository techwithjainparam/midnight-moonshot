// PRIESTATE — AUTHORIZED OFFICER PORTAL.
//
// ⚠️ OFFICER-ONLY. This page is rendered exclusively behind
// RequireOfficer (wallet connected + demo officer authorization).
// Normal users never see this route's content, the applicant queue,
// internal officer notes, or approve/reject controls.
//
// The DEMO label is kept intentionally: real government authentication
// and authorization do not exist yet (see src/auth/roles.ts and README).
//
// Review actions are APPEND-ONLY: approving/rejecting appends a new
// authorized event to the record history; prior finalized entries are
// never rewritten. (Frontend alone is not tamper-proof — true
// enforcement belongs to the backend/blockchain authorization layer.)

import { useState, useCallback, useSyncExternalStore } from 'react';
import ProductBanner from '../components/ProductBanner';
import { MOCK_PROPERTIES, type MockProperty, type ApplicationStatus } from '../data/mock-properties';
import {
  subscribe,
  getSnapshotVersion,
  getLatestStatusEvent,
  appendApproval,
  appendRejection,
} from '../data/record-history';
import {
  getAllStoredDocuments,
  getDocumentsForOfficerReview,
} from '../documents/document-store';
import { formatFileSize } from '../documents/types';
import { seedDemoDocuments } from '../documents/demo-seed';

// Seed clearly-mock application documents once so officer document
// access for applications under review is demonstrable.
seedDemoDocuments();

type OfficerFilter = 'ALL' | 'PENDING_REVIEW' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

/** Status derived from the append-only event log (latest wins). */
function effectiveStatus(p: MockProperty): ApplicationStatus {
  const latest = getLatestStatusEvent(p.id);
  if (latest?.type === 'REGISTRATION_APPROVED') return 'APPROVED';
  if (latest?.type === 'REGISTRATION_REJECTED') return 'REJECTED';
  return p.registrationStatus;
}

function statusClass(status: ApplicationStatus): string {
  switch (status) {
    case 'DRAFT': return 'status-draft';
    case 'SUBMITTED': return 'status-submitted';
    case 'PENDING_REVIEW': return 'status-pending';
    case 'APPROVED': return 'status-registered';
    case 'REJECTED': return 'status-rejected';
    default: return '';
  }
}

function zkStatusClass(status: string): string {
  switch (status) {
    case 'ZK_PROOF_VALID': return 'zk-valid';
    case 'ZK_PROOF_PENDING': return 'zk-pending';
    case 'ZK_PROOF_FAILED': return 'zk-failed';
    default: return 'zk-none';
  }
}

export default function OfficerPage() {
  // Re-render when the append-only store changes (approve/reject).
  useSyncExternalStore(subscribe, () => getSnapshotVersion());

  const [filter, setFilter] = useState<OfficerFilter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const applications = MOCK_PROPERTIES.filter((p) => {
    if (filter === 'ALL') return true;
    return effectiveStatus(p) === filter;
  });

  const selected = selectedId ? MOCK_PROPERTIES.find((p) => p.id === selectedId) ?? null : null;

  const counts = {
    ALL: MOCK_PROPERTIES.length,
    PENDING_REVIEW: MOCK_PROPERTIES.filter((p) => effectiveStatus(p) === 'PENDING_REVIEW').length,
    SUBMITTED: MOCK_PROPERTIES.filter((p) => effectiveStatus(p) === 'SUBMITTED').length,
    APPROVED: MOCK_PROPERTIES.filter((p) => effectiveStatus(p) === 'APPROVED').length,
    REJECTED: MOCK_PROPERTIES.filter((p) => effectiveStatus(p) === 'REJECTED').length,
  };

  const handleApprove = useCallback(() => {
    if (!selected) return;
    // Append-only: adds a new authorized event; history is preserved.
    appendApproval(selected.id);
    setActionResult(`Registration ${selected.propertyId} APPROVED. A new authorized event was appended to the record history.`);
    setSelectedId(null);
    setTimeout(() => setActionResult(null), 5000);
  }, [selected]);

  const handleReject = useCallback(() => {
    if (!selected) return;
    appendRejection(selected.id);
    setActionResult(`Registration ${selected.propertyId} REJECTED. A new authorized event was appended to the record history.`);
    setSelectedId(null);
    setTimeout(() => setActionResult(null), 5000);
  }, [selected]);

  return (
    <div className="page officer-page">
      <ProductBanner />

      <div className="officer-banner" role="status">
        <div className="officer-banner-inner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span className="officer-banner-label">DEMO AUTHORIZED OFFICER PORTAL</span>
          <span className="officer-banner-text">
            This is a demonstration interface. No real government authentication or authorization is implemented.
          </span>
        </div>
      </div>

      <div className="page-header">
        <h1 className="page-title">AUTHORIZED OFFICER PORTAL</h1>
        <p className="page-desc">
          Review submitted property registration applications. Approve or
          reject registrations and trigger privacy verification where
          applicable. Decisions are appended to the record history as new
          authorized events.
        </p>
      </div>

      {actionResult && (
        <div className="status-msg success officer-action-result">{actionResult}</div>
      )}

      <div className="officer-stats">
        <div className="officer-stat">
          <span className="officer-stat-value">{counts.PENDING_REVIEW}</span>
          <span className="officer-stat-label">Pending Review</span>
        </div>
        <div className="officer-stat">
          <span className="officer-stat-value">{counts.SUBMITTED}</span>
          <span className="officer-stat-label">Awaiting Assignment</span>
        </div>
        <div className="officer-stat">
          <span className="officer-stat-value">{counts.APPROVED}</span>
          <span className="officer-stat-label">Approved</span>
        </div>
        <div className="officer-stat">
          <span className="officer-stat-value">{counts.REJECTED}</span>
          <span className="officer-stat-label">Rejected</span>
        </div>
      </div>

      <div className="officer-filters">
        {(['ALL', 'PENDING_REVIEW', 'SUBMITTED', 'APPROVED', 'REJECTED'] as OfficerFilter[]).map((f) => (
          <button key={f} className={`officer-filter-btn${filter === f ? ' active' : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'ALL' ? 'All' : f.replace('_', ' ')}
            <span className="officer-filter-count">{counts[f]}</span>
          </button>
        ))}
      </div>

      {selected ? (
        <div className="officer-detail">
          <button className="back-link" onClick={() => setSelectedId(null)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
            Back to Applications
          </button>

          <div className="officer-detail-card">
            <div className="officer-detail-header">
              <div>
                <h2 className="officer-detail-title">{selected.propertyId}</h2>
                <p className="officer-detail-ref">{selected.recordReference || 'No reference yet'}</p>
              </div>
              <div className="officer-detail-badges">
                <span className={`status-pill ${statusClass(effectiveStatus(selected))}`}>
                  {effectiveStatus(selected).replace('_', ' ')}
                </span>
                <span className={`status-pill ${zkStatusClass(selected.zkProofStatus)}`}>
                  {selected.zkProofStatus.replace(/_/g, ' ')}
                </span>
              </div>
            </div>

            <div className="officer-detail-grid">
              <div className="officer-detail-section">
                <h3 className="officer-detail-section-title">Applicant & Property Information</h3>
                <div className="officer-detail-fields">
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Owner</span>
                    <span className="officer-detail-value">{selected.ownerName}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Type</span>
                    <span className="officer-detail-value">{selected.propertyType}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Survey Number</span>
                    <span className="officer-detail-value">{selected.surveyNumber}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Area</span>
                    <span className="officer-detail-value">{selected.landArea}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Builder/Developer</span>
                    <span className="officer-detail-value">{selected.builderDeveloper || 'None'}</span>
                  </div>
                </div>
              </div>

              <div className="officer-detail-section">
                <h3 className="officer-detail-section-title">Location</h3>
                <div className="officer-detail-fields">
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Address</span>
                    <span className="officer-detail-value">{selected.location}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Village</span>
                    <span className="officer-detail-value">{selected.village}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Taluka</span>
                    <span className="officer-detail-value">{selected.taluka}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">District</span>
                    <span className="officer-detail-value">{selected.district}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">State</span>
                    <span className="officer-detail-value">{selected.state}</span>
                  </div>
                </div>
              </div>

              <div className="officer-detail-section">
                <h3 className="officer-detail-section-title">Review Timeline</h3>
                <div className="officer-detail-fields">
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Submitted</span>
                    <span className="officer-detail-value">{selected.submittedDate || 'Not submitted'}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Reviewed</span>
                    <span className="officer-detail-value">{selected.reviewedDate || 'Not yet reviewed'}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Last Updated</span>
                    <span className="officer-detail-value">{selected.lastUpdated}</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">ZK Verification</span>
                    <span className={`officer-detail-value ${zkStatusClass(selected.zkProofStatus)}`}>
                      {selected.zkProofStatus.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              </div>

              {selected.officerNotes && (
                <div className="officer-detail-section">
                  <h3 className="officer-detail-section-title">Officer Notes (Internal)</h3>
                  <p className="officer-notes-text">{selected.officerNotes}</p>
                </div>
              )}

              <div className="officer-detail-section">
                <h3 className="officer-detail-section-title">Application Documents</h3>
                {(() => {
                  // Officer access: documents linked to this application are
                  // visible only while it is actively under review.
                  const docs = getDocumentsForOfficerReview(selected.id, getAllStoredDocuments());
                  if (docs.length === 0) {
                    return (
                      <p className="officer-notes-text">
                        No documents are accessible for this application. Documents
                        are available only while an application is under review.
                      </p>
                    );
                  }
                  return (
                    <>
                      {docs.map((d) => (
                        <div key={d.id} className="officer-doc-card">
                          <div className="officer-doc-row">
                            <span className="officer-doc-name" title={d.fileName}>{d.fileName}</span>
                            <span className="officer-doc-meta">{d.fileType} · {formatFileSize(d.fileSize)}</span>
                          </div>
                          <div className="officer-doc-row">
                            <span className={`doc-status-pill ${
                              d.extraction.status === 'EXTRACTION_COMPLETE' ? 'doc-status-complete'
                              : d.extraction.status === 'UNSUPPORTED_DOCUMENT' ? 'doc-status-unsupported'
                              : d.extraction.status === 'MISSING_INFORMATION' ? 'doc-status-missing'
                              : 'doc-status-review'}`}>
                              {d.extraction.status.replace(/_/g, ' ')}
                            </span>
                            {d.extraction.documentTypeLabel && (
                              <span className="officer-doc-meta">Identified as: {d.extraction.documentTypeLabel}</span>
                            )}
                          </div>
                          {Object.entries(d.extraction.fields).length > 0 && (
                            <div className="officer-doc-fields">
                              {Object.entries(d.extraction.fields)
                                .filter(([k]) => k !== 'propertyValue')
                                .map(([k, v]) => (
                                  <div key={k} className="officer-detail-field">
                                    <span className="officer-detail-label">{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
                                    <span className="officer-detail-value">{String(v)}</span>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      ))}
                      <p className="officer-notes-text">
                        Extracted values are advisory output of the document
                        analysis assistant — they do NOT certify legal validity.
                        Verify against original records. Property value remains
                        private and is never displayed here.
                      </p>
                    </>
                  );
                })()}
              </div>

              <div className="officer-detail-section">
                <h3 className="officer-detail-section-title">Privacy / ZK Status</h3>
                <p className="officer-notes-text">
                  Midnight provides the privacy-preserving proof layer that allows
                  selected eligibility conditions to be verified without unnecessarily
                  revealing sensitive property information.
                </p>
                <div className="officer-detail-fields" style={{ marginTop: '0.75rem' }}>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Property Value</span>
                    <span className="officer-detail-value private-badge">PRIVATE</span>
                  </div>
                  <div className="officer-detail-field">
                    <span className="officer-detail-label">Eligibility Threshold</span>
                    <span className="officer-detail-value">
                      {Number(selected.eligibilityThreshold).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {(effectiveStatus(selected) === 'PENDING_REVIEW' || effectiveStatus(selected) === 'SUBMITTED') ? (
              <div className="officer-actions">
                <button className="btn btn-primary officer-approve-btn" onClick={handleApprove}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  Approve Registration
                </button>
                <button className="btn btn-danger officer-reject-btn" onClick={handleReject}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                  Reject Registration
                </button>
              </div>
            ) : (
              <div className="officer-actions officer-actions-finalized">
                <p className="officer-notes-text">
                  This application has been decided (append-only). The decision
                  remains in the record history and cannot be silently rewritten;
                  any future change must be recorded as a new authorized event.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="officer-table-wrap">
          <table className="officer-table" role="table">
            <thead>
              <tr>
                <th>Application ID</th>
                <th>Property ID</th>
                <th>Owner</th>
                <th>Type</th>
                <th>District</th>
                <th>Status</th>
                <th>ZK Status</th>
                <th>Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {applications.map((p) => (
                <tr key={p.id}>
                  <td className="officer-td-mono">{p.id}</td>
                  <td className="officer-td-mono">{p.propertyId}</td>
                  <td>{p.ownerName}</td>
                  <td>{p.propertyType}</td>
                  <td>{p.district}</td>
                  <td>
                    <span className={`status-pill ${statusClass(effectiveStatus(p))}`}>
                      {effectiveStatus(p).replace('_', ' ')}
                    </span>
                  </td>
                  <td>
                    <span className={`status-pill ${zkStatusClass(p.zkProofStatus)}`}>
                      {p.zkProofStatus.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>{p.submittedDate || '--'}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelectedId(p.id)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
              {applications.length === 0 && (
                <tr>
                  <td colSpan={9} className="officer-table-empty">No applications match this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="officer-footer-note">
        <p>
          Legal ownership and government records remain authoritative off-chain.
          This officer portal is a demonstration interface only. Decisions are
          appended to record history in this demo client; tamper-resistant
          enforcement requires the backend/blockchain authorization layer.
        </p>
      </div>
    </div>
  );
}
