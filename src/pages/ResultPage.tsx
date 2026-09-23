import { useParams, Link } from 'react-router-dom';
import { getPropertyById } from '../data/mock-properties';
import { canUserViewRecord } from '../data/visibility';
import { loadOnChainEligibility } from '../data/on-chain-result';
import ProductBanner from '../components/ProductBanner';

export default function ResultPage() {
  const { id } = useParams<{ id: string }>();
  const property = id ? getPropertyById(id) : undefined;

  if (!property || !canUserViewRecord(property)) {
    return (
      <div className="page">
        <ProductBanner />
        <div className="page-header">
          <h1 className="page-title">Verification Not Available</h1>
          <p className="page-desc">No verification record is available for the requested property.</p>
          <Link to="/registry" className="btn btn-primary" style={{ marginTop: '1.5rem' }}>Back to Registry</Link>
        </div>
      </div>
    );
  }

  // The ONLY accepted source is the on-chain eligibilityResult captured when
  // the checkEligibility transaction finalized this session. It is never
  // recomputed locally from the private property value.
  const record = loadOnChainEligibility(property.propertyId);

  if (!record) {
    return (
      <div className="page result-page">
        <ProductBanner />
        <div className="result-container">
          <div className="result-hero ineligible">
            <h1 className="result-title">NO ON-CHAIN VERIFICATION THIS SESSION</h1>
            <p className="result-condition">
              No finalized eligibility proof was found for this property.
              Run verification to submit a zero-knowledge proof and record the
              contract&apos;s on-chain result.
            </p>
          </div>

          <div className="result-actions">
            <Link to={`/verify/${property.id}`} className="btn btn-primary">
              Run Verification
            </Link>
            <Link to={`/property/${property.id}`} className="btn btn-ghost">
              View Property Record
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isEligible: boolean = record.result;

  return (
    <div className="page result-page">
      <ProductBanner />

      <div className="result-container">
        <div className={`result-hero ${isEligible ? 'success' : 'ineligible'}`}>
          <div className="result-icon-wrapper">
            <div className="result-icon">
              {isEligible ? (
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
              )}
            </div>
          </div>

          <h1 className="result-title">
            {isEligible ? 'PROPERTY ELIGIBILITY VERIFIED' : 'PROPERTY NOT ELIGIBLE'}
          </h1>

          {isEligible && (
            <div className="result-badge-success">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              ZK PROOF VALID
            </div>
          )}

          <p className="result-condition">
            Requirement: Property Value &ge; {Number(property.eligibilityThreshold).toLocaleString()}
            {' -- '}
            {isEligible ? 'Condition satisfied.' : 'Condition not satisfied.'}
          </p>
        </div>

        <div className="result-details">
          <div className="result-detail-card">
            <h2 className="result-detail-title">Verification Details</h2>

            <div className="result-fields">
              <div className="result-field">
                <span className="result-field-label">Property ID</span>
                <span className="result-field-value">{property.propertyId}</span>
              </div>
              <div className="result-field">
                <span className="result-field-label">Verification Status</span>
                <span className={`result-field-value ${isEligible ? 'text-success' : 'text-muted'}`}>
                  {isEligible ? 'Eligible' : 'Not Eligible'}{' '}
                  <span className="proved-badge">PROVED</span>
                </span>
              </div>
              <div className="result-field">
                <span className="result-field-label">On-chain Disclosure</span>
                <span className="result-field-value">
                  <span className="public-badge">PUBLIC</span> Boolean eligibility
                  result only — never the property value
                </span>
              </div>
              <div className="result-field">
                <span className="result-field-label">Verification Timestamp</span>
                <span className="result-field-value">
                  {new Date(record.finalizedAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <div className="result-field">
                <span className="result-field-label">Property Value</span>
                <span className="result-field-value private-badge">PRIVATE</span>
              </div>
            </div>
          </div>

          <div className="result-explanation">
            <div className="result-explanation-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </div>
            <p>
              The verification confirms the eligibility condition without
              unnecessarily revealing the underlying private property value.
              The zero-knowledge proof provides cryptographic assurance that
              the check was performed correctly.
            </p>
          </div>

          <div className="result-actions">
            <Link to={`/property/${property.id}`} className="btn btn-ghost">
              View Property Record
            </Link>
            <Link to="/registry" className="btn btn-primary">
              Back to Registry
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
