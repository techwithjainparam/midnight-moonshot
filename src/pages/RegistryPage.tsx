import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MOCK_PROPERTIES } from '../data/mock-properties';
import PropertyCard from '../components/PropertyCard';
import ProductBanner from '../components/ProductBanner';

type FilterType = 'All' | 'Residential' | 'Commercial' | 'Agricultural' | 'Industrial';

// Registry visibility model:
//
// The registry shows ONLY finalized public records (registration
// APPROVED). Drafts, submitted and pending applications, rejections,
// officer notes, and other applicants' private information are NOT
// listed here — they are visible only to their owner and to authorized
// officers in the Officer Portal.
export default function RegistryPage() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterType>('All');

  const publicRecords = useMemo(
    () => MOCK_PROPERTIES.filter((p) => p.registrationStatus === 'APPROVED'),
    [],
  );

  const filtered = useMemo(() => {
    return publicRecords.filter((p) => {
      if (typeFilter !== 'All' && p.propertyType !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          p.propertyId.toLowerCase().includes(q) ||
          p.ownerName.toLowerCase().includes(q) ||
          p.village.toLowerCase().includes(q) ||
          p.district.toLowerCase().includes(q) ||
          p.location.toLowerCase().includes(q) ||
          p.surveyNumber.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [publicRecords, search, typeFilter]);

  return (
    <div className="page registry-page">
      <ProductBanner />

      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Property Registry</h1>
            <p className="page-desc">
              Public registry of finalized property records. Applications
              under review are not listed here.
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

      <div className="registry-controls">
        <div className="registry-search">
          <svg className="registry-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            type="text"
            className="registry-search-input"
            placeholder="Search by ID, owner, village, or survey number..."
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
            <label className="filter-label" htmlFor="type-filter">Type</label>
            <select
              id="type-filter"
              className="filter-select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as FilterType)}
            >
              <option value="All">All Types</option>
              <option value="Residential">Residential</option>
              <option value="Commercial">Commercial</option>
              <option value="Agricultural">Agricultural</option>
              <option value="Industrial">Industrial</option>
            </select>
          </div>

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
            <PropertyCard key={p.id} property={p} />
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
          <p className="registry-empty-title">No registrations found</p>
          <p className="registry-empty-desc">Try adjusting your search or filters.</p>
        </div>
      )}
    </div>
  );
}
