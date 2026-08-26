import { useParams, Link } from 'react-router-dom';
import { useSyncExternalStore } from 'react';
import { getPropertyById } from '../data/mock-properties';
import { getHistory, getSnapshotVersion, subscribe, type RecordEvent } from '../data/record-history';
import { recordVisibility } from '../data/visibility';
import ProductBanner from '../components/ProductBanner';

function statusLabel(status: string): string {
  switch (status) {
    case 'APPROVED': return 'Approved';
    case 'PENDING_REVIEW': return 'Pending Review';
    case 'SUBMITTED': return 'Submitted';
    case 'REJECTED': return 'Rejected';
    case 'DRAFT': return 'Draft';
    default: return status;
  }
}

function zkStatusLabel(status: string): string {
  switch (status) {
    case 'ZK_PROOF_VALID': return 'Valid';
    case 'ZK_PROOF_PENDING': return 'Pending';
    case 'ZK_PROOF_FAILED': return 'Failed';
    default: return 'Not Started';
  }
}

function eventLabel(type: RecordEvent['type']): string {
  switch (type) {
    case 'REGISTRATION_SUBMITTED': return 'Registration Submitted';
    case 'REGISTRATION_APPROVED': return 'Registration Approved';
    case 'REGISTRATION_REJECTED': return 'Registration Rejected';
    case 'ZK_VERIFICATION_COMPLETED': return 'ZK Verification Completed';
    default: return type;
  }
}

// Append-only history timeline. Events are rendered oldest-first and can
// only grow — the UI offers no edit/delete, mirroring the store's
// append-only API. (True tamper-resistance must be enforced by the
// backend/blockchain layer; see README.)
function RecordHistory({ propertyId }: { propertyId: string }) {
  useSyncExternalStore(subscribe, () => getSnapshotVersion());
  const events = getHistory(propertyId);

  return (
    <div className="property-record-section">
      <h2 className="property-record-section-title">Record History</h2>
      <p className="record-history-note">
        Finalized records are append-only. Existing entries are never edited,
        deleted, or replaced — future changes are recorded as new authorized
        events below.
      </p>
      <ol className="record-history">
        {events.map((e) => (
          <li key={e.seq} className={`record-history-event actor-${e.actor.toLowerCase()}`}>
            <span className="record-history-date">{e.date}</span>
            <span className="record-history-body">
              <span className="record-history-title">{eventLabel(e.type)}</span>
              <span className="record-history-summary">{e.summary}</span>
              <span className="record-history-meta">
                by {e.actor === 'OFFICER' ? 'Authorized Officer' : 'Owner'} · event #{e.seq}
              </span>
            </span>
          </li>
        ))}
        {events.length === 0 && (
          <li className="record-history-event">
            <span className="record-history-body">
              <span className="record-history-summary">No recorded events yet.</span>
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}

export default function PropertyPage() {
  const { id } = useParams<{ id: string }>();
  const property = id ? getPropertyById(id) : undefined;
  const visibility = property ? recordVisibility(property) : 'restricted';

  if (!property || visibility === 'restricted') {
    return (
      <div className="page">
        <ProductBanner />
        <div className="page-header">
          <h1 className="page-title">Property Record Not Available</h1>
          <p className="page-desc">
            This record does not exist or is not part of the public registry.
          </p>
          <Link to="/registry" className="btn btn-primary" style={{ marginTop: '1.5rem' }}>
            Back to Registry
          </Link>
        </div>
      </div>
    );
  }

  const finalized = property.registrationStatus === 'APPROVED';

  return (
    <div className="page property-page">
      <ProductBanner />

      <div className="page-header">
        <Link to="/registry" className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back to Registry
        </Link>
      </div>

      <div className="property-record">
        <div className="property-record-header">
          <div className="property-record-badge">SAMPLE RECORD</div>
          <h1 className="property-record-title">{property.propertyId}</h1>
          <p className="property-record-ref">
            {property.recordReference ? `Reference: ${property.recordReference}` : 'No reference assigned'}
          </p>
        </div>

        <div className="property-record-grid">
          <div className="property-record-main">
            <div className="property-record-section">
              <h2 className="property-record-section-title">Property Details</h2>

              <div className="record-field-grid">
                <div className="record-field">
                  <span className="record-field-label">Owner Name</span>
                  <span className="record-field-value">{property.ownerName}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Property Type</span>
                  <span className="record-field-value">{property.propertyType}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Land Area</span>
                  <span className="record-field-value">{property.landArea}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Survey / Gat Number</span>
                  <span className="record-field-value">{property.surveyNumber}</span>
                </div>
                {property.builderDeveloper && (
                  <div className="record-field">
                    <span className="record-field-label">Builder / Developer</span>
                    <span className="record-field-value">{property.builderDeveloper}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="property-record-section">
              <h2 className="property-record-section-title">Location</h2>

              <div className="record-field-grid">
                <div className="record-field">
                  <span className="record-field-label">Address</span>
                  <span className="record-field-value">{property.location}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Village</span>
                  <span className="record-field-value">{property.village}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Taluka</span>
                  <span className="record-field-value">{property.taluka}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">District</span>
                  <span className="record-field-value">{property.district}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">State</span>
                  <span className="record-field-value">{property.state}</span>
                </div>
              </div>
            </div>

            <div className="property-record-section">
              <h2 className="property-record-section-title">Registration</h2>

              <div className="record-field-grid">
                <div className="record-field">
                  <span className="record-field-label">Application Status</span>
                  <span className={`record-field-value record-status ${
                    finalized ? 'status-registered' :
                    property.registrationStatus === 'PENDING_REVIEW' || property.registrationStatus === 'SUBMITTED' ? 'status-pending' :
                    property.registrationStatus === 'REJECTED' ? 'status-rejected' :
                    'status-draft'
                  }`}>
                    {statusLabel(property.registrationStatus)}
                  </span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Record Reference</span>
                  <span className="record-field-value record-field-mono">
                    {property.recordReference || 'Pending'}
                  </span>
                </div>
                {property.submittedDate && (
                  <div className="record-field">
                    <span className="record-field-label">Submitted</span>
                    <span className="record-field-value">{property.submittedDate}</span>
                  </div>
                )}
                {property.reviewedDate && (
                  <div className="record-field">
                    <span className="record-field-label">Reviewed</span>
                    <span className="record-field-value">{property.reviewedDate}</span>
                  </div>
                )}
                <div className="record-field">
                  <span className="record-field-label">Last Updated</span>
                  <span className="record-field-value">{property.lastUpdated}</span>
                </div>
              </div>
            </div>

            <RecordHistory propertyId={property.id} />
          </div>

          <div className="property-record-sidebar">
            <div className="property-record-section">
              <h2 className="property-record-section-title">Parcel Information</h2>
              <div className="parcel-placeholder">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <path d="M3 12h18M12 3v18M3 7h5M3 17h5M16 3v5M16 14v7"/>
                </svg>
                <span className="parcel-placeholder-text">Parcel Map</span>
                <span className="parcel-placeholder-id">{property.surveyNumber}</span>
              </div>
            </div>

            <div className="property-record-section">
              <h2 className="property-record-section-title">Status Summary</h2>
              <div className="status-summary">
                <div className="status-summary-row">
                  <span className="status-summary-label">Registration</span>
                  <span className={`status-pill ${
                    finalized ? 'status-registered' :
                    property.registrationStatus === 'PENDING_REVIEW' || property.registrationStatus === 'SUBMITTED' ? 'status-pending' :
                    property.registrationStatus === 'REJECTED' ? 'status-rejected' :
                    'status-draft'
                  }`}>
                    {statusLabel(property.registrationStatus)}
                  </span>
                </div>
                <div className="status-summary-row">
                  <span className="status-summary-label">Authorized Review</span>
                  <span className={`status-pill ${
                    finalized ? 'status-registered' :
                    property.registrationStatus === 'REJECTED' ? 'status-rejected' :
                    'status-pending'
                  }`}>
                    {finalized ? 'Verified' :
                     property.registrationStatus === 'REJECTED' ? 'Rejected' :
                     'Pending'}
                  </span>
                </div>
                <div className="status-summary-row">
                  <span className="status-summary-label">Privacy Proof</span>
                  <span className={`status-pill ${
                    property.zkProofStatus === 'ZK_PROOF_VALID' ? 'zk-valid' :
                    property.zkProofStatus === 'ZK_PROOF_PENDING' ? 'zk-pending' :
                    property.zkProofStatus === 'ZK_PROOF_FAILED' ? 'zk-failed' :
                    'zk-none'
                  }`}>
                    {zkStatusLabel(property.zkProofStatus)}
                  </span>
                </div>
              </div>
            </div>

            {finalized && (
              <div className="property-record-section">
                <h2 className="property-record-section-title">Finalized Record</h2>
                <div className="finalized-note">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                  <p>
                    This registration is finalized. It cannot be edited, deleted,
                    or silently replaced. Any future change (e.g. an ownership
                    transfer) will be recorded as a new authorized event in the
                    record history above.
                  </p>
                </div>
              </div>
            )}

            <div className="property-record-section">
              <h2 className="property-record-section-title">Actions</h2>
              <p className="property-record-note">
                Legal ownership and government records remain authoritative
                off-chain. Midnight provides privacy-preserving eligibility
                verification.
              </p>
              {finalized && property.zkProofStatus !== 'ZK_PROOF_VALID' && (
                <Link to={`/verify/${property.id}`} className="btn btn-primary property-record-cta">
                  Run ZK Verification
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                  </svg>
                </Link>
              )}
              {finalized && property.zkProofStatus === 'ZK_PROOF_VALID' && (
                <Link to={`/verification/${property.id}`} className="btn btn-ghost property-record-cta">
                  View Verification Result
                </Link>
              )}
              {!finalized && (
                <p className="property-record-note">
                  This application is awaiting authorized officer review.
                  Review status is updated as new authorized events in the
                  record history.
                </p>
              )}
              {property.registrationStatus === 'REJECTED' && (
                <Link to="/register" className="btn btn-primary property-record-cta">
                  Register New Property
                </Link>
              )}
            </div>

            <div className="property-record-section">
              <div className="property-record-private-note">
                <span className="private-note-label">PRIVATE</span>
                <span className="private-note-text">
                  Property valuation data is private and used only during
                  zero-knowledge verification.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
