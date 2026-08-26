import { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import DocumentUpload from '../components/DocumentUpload';
import type { MockProperty } from '../data/mock-properties';
import { newRegistrationId } from '../data/mock-properties';
import { useAuth } from '../auth/AuthContext';
import {
  getDocumentsForOwner,
  linkDocumentToApplication,
} from '../documents/document-store';
import type { ExtractionResult } from '../documents/types';
import { applyExtractedFields } from '../documents/merge-extracted';

const EMPTY_FORM: Omit<MockProperty, 'id' | 'registrationStatus' | 'zkProofStatus' | 'submittedDate' | 'reviewedDate' | 'lastUpdated' | 'officerNotes' | 'propertyImage' | 'parcelMap'> = {
  ownerName: '',
  propertyId: '',
  surveyNumber: '',
  location: '',
  village: '',
  taluka: '',
  district: '',
  state: 'Maharashtra',
  landArea: '',
  propertyType: 'Residential',
  recordReference: '',
  builderDeveloper: '',
  propertyValue: 0n,
  eligibilityThreshold: 1000000n,
};

type FormErrors = Record<string, string>;

function validate(form: typeof EMPTY_FORM): FormErrors {
  const errors: FormErrors = {};
  if (!form.ownerName.trim()) errors.ownerName = 'Owner name is required.';
  if (!form.propertyId.trim()) errors.propertyId = 'Property ID is required.';
  if (!form.surveyNumber.trim()) errors.surveyNumber = 'Survey/Gat number is required.';
  if (!form.location.trim()) errors.location = 'Address is required.';
  if (!form.village.trim()) errors.village = 'Village is required.';
  if (!form.taluka.trim()) errors.taluka = 'Taluka is required.';
  if (!form.district.trim()) errors.district = 'District is required.';
  if (!form.landArea.trim()) errors.landArea = 'Land area is required.';
  return errors;
}

/** Badge marking a value that was auto-filled from the uploaded document. */
function ExtractedBadge() {
  return <span className="extracted-badge">Extracted from document</span>;
}

export default function RegisterPage() {
  const { address } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  // Keys the user has edited manually (extraction never overwrites these).
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  // Keys auto-filled by document extraction (drives the review badges).
  const [extractedKeys, setExtractedKeys] = useState<ReadonlySet<string>>(new Set());
  const [docReference, setDocReference] = useState<{ documentNumber?: string; registrationDate?: string } | null>(null);
  const [docProcessed, setDocProcessed] = useState(false);

  const set = useCallback(<K extends keyof typeof form>(key: K, val: (typeof form)[K]) => {
    setForm((prev) => ({ ...prev, [key]: val }));
    setDirtyKeys((prev) => new Set(prev).add(String(key)));
    setExtractedKeys((prev) => {
      if (!prev.has(String(key))) return prev;
      const n = new Set(prev);
      n.delete(String(key));
      return n;
    });
    if (errors[key]) setErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
  }, [errors]);

  /**
   * Auto-fill the form from extracted document information.
   * Only EMPTY (or untouched-default) fields are populated — anything the
   * user already typed is never overwritten. Every applied value stays
   * editable and is badged "Extracted from document"; nothing is
   * submitted without explicit user confirmation.
   */
  const handleExtracted = useCallback((result: ExtractionResult) => {
    const { form: merged, applied } = applyExtractedFields(form, result.fields, dirtyKeys);
    setForm(merged);
    setExtractedKeys(applied);
    setDocReference({
      documentNumber: result.fields.documentNumber,
      registrationDate: result.fields.registrationDate,
    });
    setDocProcessed(true);
  }, [form, dirtyKeys]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate(form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Link the most recent unlinked uploaded document to this application
    // so an authorized officer can access it during review.
    const applicationId = newRegistrationId();
    if (address && docProcessed) {
      const pendingDoc = getDocumentsForOwner(address)
        .filter((d) => !d.linkedApplicationId)
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
      if (pendingDoc) linkDocumentToApplication(address, pendingDoc.id, applicationId);
    }
    sessionStorage.setItem('pendingRegistration', JSON.stringify({
      applicationId,
      ownerName: form.ownerName,
      propertyId: form.propertyId,
      propertyType: form.propertyType,
      surveyNumber: form.surveyNumber,
      landArea: form.landArea,
      location: form.location,
      village: form.village,
      taluka: form.taluka,
      district: form.district,
      state: form.state,
      builderDeveloper: form.builderDeveloper,
      propertyValue: form.propertyValue === 0n ? '' : form.propertyValue.toString(),
    }));
    navigate('/register/review');
  }, [form, address, docProcessed, navigate]);

  const badge = (key: string) => (extractedKeys.has(key) ? <ExtractedBadge /> : null);

  return (
    <div className="page register-page">
      <ProductBanner />

      <div className="page-header">
        <Link to="/registry" className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back to Registry
        </Link>
        <h1 className="page-title">Register Property</h1>
        <p className="page-desc">
          Submit a new property/land registration application. After submission,
          the application will be reviewed by an authorized registry officer.
        </p>
      </div>

      <form className="register-form" onSubmit={handleSubmit} noValidate>
        <div className="register-form-section">
          <h2 className="register-form-section-title">Owner Information</h2>

          <div className="form-field">
            <label className="form-label" htmlFor="ownerName">
              Owner Name * {badge('ownerName')}
            </label>
            <input id="ownerName" type="text" className={`form-input${errors.ownerName ? ' form-input-error' : ''}`}
              placeholder="Full legal name of property owner"
              value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
            {errors.ownerName && <span className="form-error">{errors.ownerName}</span>}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="builderDeveloper">Builder / Developer</label>
            <input id="builderDeveloper" type="text" className="form-input"
              placeholder="Builder or developer name (if applicable)"
              value={form.builderDeveloper} onChange={(e) => set('builderDeveloper', e.target.value)} />
          </div>
        </div>

        <div className="register-form-section">
          <h2 className="register-form-section-title">Document Information</h2>

          {address ? (
            <DocumentUpload
              ownerAddress={address}
              onExtracted={handleExtracted}
              onRemoved={() => {
                setDocReference(null);
                setDocProcessed(false);
                setExtractedKeys(new Set());
              }}
            />
          ) : (
            <p className="dash-empty-text">Connect your wallet to upload documents.</p>
          )}

          {docProcessed && (
            <div className="extracted-panel">
              <div className="extracted-panel-header">
                <h3 className="extracted-panel-title">Extracted Information</h3>
                <span className="extracted-panel-note">
                  Review each value and correct any mistakes before continuing.
                  You can also enter missing information manually below.
                </span>
              </div>

              <div className="form-field-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="x-ownerName">Owner Name {badge('ownerName')}</label>
                  <input id="x-ownerName" type="text" className="form-input"
                    placeholder="Not found — enter manually"
                    value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="x-propertyType">Property Type {badge('propertyType')}</label>
                  <select id="x-propertyType" className="form-input"
                    value={form.propertyType} onChange={(e) => set('propertyType', e.target.value)}>
                    <option value="Residential">Residential</option>
                    <option value="Commercial">Commercial</option>
                    <option value="Agricultural">Agricultural</option>
                    <option value="Industrial">Industrial</option>
                  </select>
                </div>
              </div>

              <div className="form-field-row">
                <div className="form-field">
                  <label className="form-label" htmlFor="x-surveyNumber">Survey / Gat No. {badge('surveyNumber')}</label>
                  <input id="x-surveyNumber" type="text" className="form-input"
                    placeholder="Not found — enter manually"
                    value={form.surveyNumber} onChange={(e) => set('surveyNumber', e.target.value)} />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="x-landArea">Land Area {badge('landArea')}</label>
                  <input id="x-landArea" type="text" className="form-input"
                    placeholder="Not found — enter manually"
                    value={form.landArea} onChange={(e) => set('landArea', e.target.value)} />
                </div>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="x-location">Address {badge('location')}</label>
                <input id="x-location" type="text" className="form-input"
                  placeholder="Not found — enter manually"
                  value={form.location} onChange={(e) => set('location', e.target.value)} />
              </div>

              {(docReference?.documentNumber || docReference?.registrationDate) && (
                <div className="extracted-reference-row">
                  {docReference.documentNumber && (
                    <div className="extracted-reference-item">
                      <span className="form-label">Document Number <ExtractedBadge /></span>
                      <span className="extracted-reference-value">{docReference.documentNumber}</span>
                    </div>
                  )}
                  {docReference.registrationDate && (
                    <div className="extracted-reference-item">
                      <span className="form-label">Registration Date <ExtractedBadge /></span>
                      <span className="extracted-reference-value">{docReference.registrationDate}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="register-form-section">
          <h2 className="register-form-section-title">Property Information</h2>

          <div className="form-field-row">
            <div className="form-field">
              <label className="form-label" htmlFor="propertyId">Property ID *</label>
              <input id="propertyId" type="text" className={`form-input${errors.propertyId ? ' form-input-error' : ''}`}
                placeholder="e.g. PR-2024-00001"
                value={form.propertyId} onChange={(e) => set('propertyId', e.target.value)} />
              {errors.propertyId && <span className="form-error">{errors.propertyId}</span>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="propertyType">Property Type *</label>
              <select id="propertyType" className="form-input" value={form.propertyType}
                onChange={(e) => set('propertyType', e.target.value)}>
                <option value="Residential">Residential</option>
                <option value="Commercial">Commercial</option>
                <option value="Agricultural">Agricultural</option>
                <option value="Industrial">Industrial</option>
              </select>
            </div>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="surveyNumber">Survey / Gat Number *</label>
            <input id="surveyNumber" type="text" className={`form-input${errors.surveyNumber ? ' form-input-error' : ''}`}
              placeholder="e.g. Gat No. 124/A"
              value={form.surveyNumber} onChange={(e) => set('surveyNumber', e.target.value)} />
            {errors.surveyNumber && <span className="form-error">{errors.surveyNumber}</span>}
          </div>

          <div className="form-field-row">
            <div className="form-field">
              <label className="form-label" htmlFor="landArea">Land Area *</label>
              <input id="landArea" type="text" className={`form-input${errors.landArea ? ' form-input-error' : ''}`}
                placeholder="e.g. 2,400 sq ft"
                value={form.landArea} onChange={(e) => set('landArea', e.target.value)} />
              {errors.landArea && <span className="form-error">{errors.landArea}</span>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="propertyValue">Property Value (Private)</label>
              <input id="propertyValue" type="text" className="form-input"
                placeholder="Value stays private"
                value={form.propertyValue === 0n ? '' : form.propertyValue.toString()}
                onChange={(e) => {
                  const v = e.target.value.replace(/[,_]/g, '').trim();
                  if (/^\d*$/.test(v)) {
                    set('propertyValue', v === '' ? 0n : BigInt(v));
                  }
                }} />
              <span className="form-hint">Used only for ZK eligibility verification. Never stored publicly.</span>
            </div>
          </div>
        </div>

        <div className="register-form-section">
          <h2 className="register-form-section-title">Location</h2>

          <div className="form-field">
            <label className="form-label" htmlFor="location">Address *</label>
            <input id="location" type="text" className={`form-input${errors.location ? ' form-input-error' : ''}`}
              placeholder="Street address or plot details"
              value={form.location} onChange={(e) => set('location', e.target.value)} />
            {errors.location && <span className="form-error">{errors.location}</span>}
          </div>

          <div className="form-field-row form-field-row-3">
            <div className="form-field">
              <label className="form-label" htmlFor="village">Village *</label>
              <input id="village" type="text" className={`form-input${errors.village ? ' form-input-error' : ''}`}
                placeholder="Village or town"
                value={form.village} onChange={(e) => set('village', e.target.value)} />
              {errors.village && <span className="form-error">{errors.village}</span>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="taluka">Taluka *</label>
              <input id="taluka" type="text" className={`form-input${errors.taluka ? ' form-input-error' : ''}`}
                placeholder="Taluka"
                value={form.taluka} onChange={(e) => set('taluka', e.target.value)} />
              {errors.taluka && <span className="form-error">{errors.taluka}</span>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="district">District *</label>
              <input id="district" type="text" className={`form-input${errors.district ? ' form-input-error' : ''}`}
                placeholder="District"
                value={form.district} onChange={(e) => set('district', e.target.value)} />
              {errors.district && <span className="form-error">{errors.district}</span>}
            </div>
          </div>

          <div className="form-field" style={{ maxWidth: 320 }}>
            <label className="form-label" htmlFor="state">State</label>
            <input id="state" type="text" className="form-input"
              value={form.state} onChange={(e) => set('state', e.target.value)} />
          </div>
        </div>

        <div className="register-form-footer">
          <p className="register-form-note">
            Review your information carefully — including anything extracted
            from your document — before confirming. Your uploaded document and
            its details stay private to you and are shared only with the
            authorized officer reviewing this application. In a production
            system, final legal verification is performed by the authorized
            officer.
          </p>
          <button type="submit" className="btn btn-primary btn-lg">
            Review &amp; Confirm
          </button>
        </div>
      </form>
    </div>
  );
}
