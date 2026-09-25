import { useParams, Link } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { useAuth } from '../auth/AuthContext';
import { usePriestateRegistrations } from '../hooks/usePriestateRegistrations';
import { toRegistrationDetail } from '../registration-view';

// Property record detail, rendered from the contract's on-chain
// registration state. The ledger's public record is intentionally thin and
// never contains the confidential property value. Fields the contract does
// not store (owner name, survey number, village, parcel map, ZK proof
// status…) are shown as an explicit "Unavailable" state instead of being
// invented from mock data. A future off-chain registry backend can add them.

const UNAVAILABLE = 'Unavailable';

export default function PropertyPage() {
  const { id } = useParams<{ id: string }>();
  // Reuse the shared auth wallet so no second detection/connect instance is
  // created for this page.
  const { wallet } = useAuth();
  const { connectState, connectError, registrations } = usePriestateRegistrations(1_000_000n, wallet);

  const lookup =
    id !== undefined && /^\d+$/.test(id)
      ? (() => {
          const key = BigInt(id);
          const record = registrations.get(key);
          return record === undefined ? undefined : ({ key, record } as const);
        })()
      : undefined;
  const found = lookup;

  const leading = (
    <div className="page-header">
      <Link to="/registry" className="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
        Back to Registry
      </Link>
    </div>
  );

  if (connectState === 'failed') {
    return (
      <div className="page property-page">
        <ProductBanner />
        {leading}
        <h1 className="property-record-title">Contract Unavailable</h1>
        <div className="status-msg error" role="alert">{connectError}</div>
      </div>
    );
  }

  if (connectState !== 'connected' || !found) {
    return (
      <div className="page property-page">
        <ProductBanner />
        {leading}
        <div className="page-header">
          {connectState === 'connecting' ? (
            <h1 className="property-record-title">Connecting to the contract…</h1>
          ) : (
            <>
              <h1 className="property-record-title">Property Record Not Available</h1>
              <p className="page-desc">
                This registration does not exist in the on-chain registry or
                has not been finalized. Only contract ledger records are shown —
                nothing is fabricated.
              </p>
              <Link to="/registry" className="btn btn-primary" style={{ marginTop: '1.5rem' }}>
                Back to Registry
              </Link>
            </>
          )}
        </div>
      </div>
    );
  }

  const d = toRegistrationDetail(found.key, found.record);

  return (
    <div className="page property-page">
      <ProductBanner />

      {leading}

      <div className="property-record">
        <div className="property-record-header">
          <div className="property-record-badge">ON-CHAIN RECORD</div>
          <h1 className="property-record-title">Registration {d.id}</h1>
          <p className="property-record-ref">
            Status read from the contract&apos;s public ledger state.
          </p>
        </div>

        <div className="property-record-grid">
          <div className="property-record-main">
            <div className="property-record-section">
              <h2 className="property-record-section-title">Registration Metadata</h2>

              <div className="record-field-grid">
                <div className="record-field">
                  <span className="record-field-label">Registration ID</span>
                  <span className="record-field-value record-field-mono">{d.id}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Area</span>
                  <span className="record-field-value">{d.area}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">District</span>
                  <span className="record-field-value">{d.district}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Owner / Applicant Binding</span>
                  <span className="record-field-value record-field-mono">
                    {d.ownerKey}…
                  </span>
                </div>
              </div>
            </div>

            <div className="property-record-section">
              <h2 className="property-record-section-title">Ledger Timeline</h2>

              <div className="record-field-grid">
                <div className="record-field">
                  <span className="record-field-label">Submitted</span>
                  <span className="record-field-value">{d.submittedLabel}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Reviewed</span>
                  <span className="record-field-value">{d.reviewedLabel}</span>
                </div>
                <div className="record-field">
                  <span className="record-field-label">Reviewed By</span>
                  <span className="record-field-value record-field-mono">
                    {d.reviewedByLabel}
                  </span>
                </div>
              </div>
            </div>

            <div className="property-record-section">
              <h2 className="property-record-section-title">Owner / Location Details</h2>

              <div className="record-field-grid">
                {[
                  ['Owner Name', UNAVAILABLE],
                  ['Survey / Gat Number', UNAVAILABLE],
                  ['Address', UNAVAILABLE],
                  ['Village', UNAVAILABLE],
                  ['Taluka', UNAVAILABLE],
                  ['State', UNAVAILABLE],
                ].map(([label, value]) => (
                  <div className="record-field" key={label}>
                    <span className="record-field-label">{label}</span>
                    <span className="record-field-value record-field-unavailable">{value}</span>
                  </div>
                ))}
                <p className="property-record-note">
                  These descriptive fields are not stored on the contract. They
                  belong to an off-chain registry backend (not built yet) and
                  are shown as Unavailable rather than fabricated.
                </p>
              </div>
            </div>
          </div>

          <div className="property-record-sidebar">
            <div className="property-record-section">
              <h2 className="property-record-section-title">Parcel Information</h2>
              <div className="parcel-placeholder">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <path d="M3 12h18M12 3v18M3 7h5M3 17h5M16 3v5M16 14v7"/>
                </svg>
                <span className="parcel-placeholder-text">Parcel Map — Unavailable</span>
              </div>
            </div>

            <div className="property-record-section">
              <h2 className="property-record-section-title">Status Summary</h2>
              <div className="status-summary">
                <div className="status-summary-row">
                  <span className="status-summary-label">Registration</span>
                  <span className={`status-pill ${d.statusClass}`}>{d.statusLabel}</span>
                </div>
                <div className="status-summary-row">
                  <span className="status-summary-label">Privacy Proof</span>
                  <span className="status-pill zk-none">Unavailable</span>
                </div>
              </div>
            </div>

            <div className="property-record-section">
              <div className="property-record-private-note">
                <span className="private-note-label">PRIVATE</span>
                <span className="private-note-text">
                  Property valuation data is never stored on the ledger and is
                  never displayed here.
                </span>
              </div>
            </div>

            <div className="property-record-section">
              <h2 className="property-record-section-title">Actions</h2>
              <p className="property-record-note">
                Legal ownership and government records remain authoritative
                off-chain. Midnight provides privacy-preserving eligibility
                verification.
              </p>
              <Link to="/register" className="btn btn-primary property-record-cta">
                Register New Property
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
