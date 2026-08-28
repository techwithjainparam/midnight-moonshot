import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { usePriestateRegistrations } from '../hooks/usePriestateRegistrations';
import { publicRegistryItems, type RegistryItem } from '../registration-view';

// Registry visibility model:
//
// The registry shows ONLY finalized public records (registration APPROVED)
// read directly from the contract's public ledger state. Drafts, submitted
// and pending applications, rejections, officer notes, and other
// applicants' private information are NOT listed here — and are never
// fabricated from mock data.
export default function RegistryPage() {
  const [search, setSearch] = useState('');
  const { connectState, connectError, registrations } = usePriestateRegistrations();

  const publicRecords: RegistryItem[] = useMemo(
    () => publicRegistryItems(registrations),
    [registrations],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return publicRecords.filter((p) => {
      if (q === '') return true;
      return (
        p.id.includes(q) ||
        p.ownerKey.toLowerCase().includes(q) ||
        p.district.toLowerCase().includes(q) ||
        p.area.toLowerCase().includes(q)
      );
    });
  }, [publicRecords, search]);

  return (
    <div className="page registry-page">
      <ProductBanner />

      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Property Registry</h1>
            <p className="page-desc">
              Public registry of finalized property records, read from the
              contract&apos;s on-chain state. Applications under review are not
              listed here.
            </p>
          </div>
          <Link to="/register" className="btn btn-primary register-cta-btn">
            Register Property
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </Link>
        </div>
      </div>

      {connectState === 'failed' && (
        <div className="status-msg error" role="alert">
          Could not reach the on-chain registry: {connectError}
        </div>
      )}

      {connectState === 'connecting' && (
        <div className="registry-empty">
          <p className="registry-empty-title">Connecting to the contract…</p>
          <p className="registry-empty-desc">
            Reading the finalized registry from the on-chain public ledger.
          </p>
        </div>
      )}

      {connectState === 'connected' && (
        <>
          <div className="registry-controls">
            <div className="registry-search">
              <svg className="registry-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8"/>
                <path d="M21 21l-4.35-4.35"/>
              </svg>
              <input
                type="text"
                className="registry-search-input"
                placeholder="Search by ID, owner key, district, or area..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search properties"
              />
              {search && (
                <button
                  className="registry-search-clear"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>

            <div className="registry-filters">
              <div className="filter-group">
                <span className="filter-label">Status</span>
                <span className="registry-visibility-note">Finalized public records only</span>
              </div>
            </div>
          </div>

          <div className="registry-count">
            {filtered.length} {filtered.length === 1 ? 'registration' : 'registrations'} found
          </div>

          {filtered.length > 0 ? (
            <div className="registry-grid">
              {filtered.map((p) => (
                <article key={p.id} className="property-card" aria-label={`Registration ${p.id}`}>
                  <div className="property-card-top">
                    <div className="property-card-type">On-chain</div>
                    <span className={`property-card-status ${p.statusClass}`}>{p.statusLabel}</span>
                  </div>

                  <div className="property-card-id">Registration {p.id}</div>

                  <div className="property-card-location">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                      <circle cx="12" cy="10" r="3"/>
                    </svg>
                    <span>District {p.district} · Owner {p.ownerKey}</span>
                  </div>

                  <div className="property-card-details">
                    <div className="property-card-detail">
                      <span className="property-card-detail-label">Area</span>
                      <span className="property-card-detail-value">{p.area}</span>
                    </div>
                    <div className="property-card-detail">
                      <span className="property-card-detail-label">Submitted</span>
                      <span className="property-card-detail-value">{p.submittedLabel}</span>
                    </div>
                  </div>

                  <div className="property-card-footer">
                    <Link to={`/property/${p.id}`} className="btn btn-ghost btn-sm property-card-link">
                      View Record
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12h14M12 5l7 7-7 7"/>
                      </svg>
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="registry-empty">
              <div className="registry-empty-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8"/>
                  <path d="M21 21l-4.35-4.35"/>
                </svg>
              </div>
              <p className="registry-empty-title">No finalized registrations on-chain</p>
              <p className="registry-empty-desc">
                Submissions finalized via the submit → approve flow will appear
                here from the contract ledger. Sample/demo records are not part
                of the on-chain registry.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
