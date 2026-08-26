import { Link } from 'react-router-dom';
import type { MockProperty } from '../data/mock-properties';

interface PropertyCardProps {
  property: MockProperty;
}

function statusClass(status: string): string {
  switch (status) {
    case 'APPROVED': return 'status-registered';
    case 'PENDING_REVIEW': return 'status-pending';
    case 'SUBMITTED': return 'status-submitted';
    case 'REJECTED': return 'status-rejected';
    case 'DRAFT': return 'status-draft';
    default: return '';
  }
}

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

export default function PropertyCard({ property }: PropertyCardProps) {
  return (
    <article className="property-card" aria-label={`Property ${property.propertyId}`}>
      <div className="property-card-top">
        <div className="property-card-type">{property.propertyType}</div>
        <span className={`property-card-status ${statusClass(property.registrationStatus)}`}>
          {statusLabel(property.registrationStatus)}
        </span>
      </div>

      <div className="property-card-id">{property.propertyId}</div>

      <div className="property-card-location">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        <span>{property.village}, {property.district}</span>
      </div>

      <div className="property-card-details">
        <div className="property-card-detail">
          <span className="property-card-detail-label">Area</span>
          <span className="property-card-detail-value">{property.landArea}</span>
        </div>
        <div className="property-card-detail">
          <span className="property-card-detail-label">Survey</span>
          <span className="property-card-detail-value">{property.surveyNumber}</span>
        </div>
      </div>

      <div className="property-card-footer">
        <Link to={`/property/${property.id}`} className="btn btn-ghost btn-sm property-card-link">
          View Record
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </Link>
      </div>
    </article>
  );
}
