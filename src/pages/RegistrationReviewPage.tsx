import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { useWallet } from '../hooks/useWallet';
import ProofAnimation from '../ProofAnimation';
import { type VerificationStep } from '../components/VerificationProgress';

interface RegistrationData {
  ownerName: string;
  propertyId: string;
  propertyType: string;
  surveyNumber: string;
  landArea: string;
  location: string;
  village: string;
  taluka: string;
  district: string;
  state: string;
  builderDeveloper: string;
  propertyValue: string;
}

export default function RegistrationReviewPage() {
  const wallet = useWallet();
  const [data] = useState<RegistrationData>(() => {
    const raw = sessionStorage.getItem('pendingRegistration');
    return raw ? JSON.parse(raw) : {
      ownerName: 'Demo Owner',
      propertyId: 'PR-2024-DEMO',
      propertyType: 'Residential',
      surveyNumber: 'Gat No. 100',
      landArea: '2,000 sq ft',
      location: 'Demo Address',
      village: 'Demo Village',
      taluka: 'Demo Taluka',
      district: 'Pune',
      state: 'Maharashtra',
      builderDeveloper: '',
      propertyValue: '1200000',
    };
  });

  const [step, setStep] = useState<'review' | 'submitting' | 'submitted'>('review');
  const [proofStep, setProofStep] = useState<VerificationStep>('wallet-required');
  const [onChainEligible, setOnChainEligible] = useState<boolean | null>(null);

  const handleProofFlow = useCallback(async () => {
    if (!wallet.wallet) return;
    setProofStep('preparing');
    try {
      const threshold = 1000000n;
      const deployment$ = wallet.manager.resolve(undefined, threshold);
      await new Promise<void>((resolve, reject) => {
        const sub = deployment$.subscribe({
          next: (d) => {
            if (d.status === 'deployed') { sub.unsubscribe(); resolve(); }
            if (d.status === 'failed') { sub.unsubscribe(); reject(d.error); }
          },
          error: (err) => { sub.unsubscribe(); reject(err); },
        });
      });
      setProofStep('generating-proof');
      const deployment = wallet.deployments.find(
        (d) => d.status === 'deployed' && d.api.deployedContractAddress
      );
      if (deployment && deployment.status === 'deployed') {
        const val = data.propertyValue ? BigInt(data.propertyValue.replace(/[,_]/g, '')) : 0n;
        // Resolves with the ON-CHAIN eligibilityResult from the contract's
        // public ledger state — never a client-side recomputation. The
        // private property value stays inside the witness.
        const result = await deployment.api.checkEligibility(val);
        setOnChainEligible(result);
        setProofStep('verified');
      } else {
        throw new Error('Contract deployment did not complete.');
      }
    } catch {
      setProofStep('error');
    }
  }, [wallet, data]);

  const handleSubmit = useCallback(() => {
    setStep('submitting');
    setTimeout(() => {
      sessionStorage.removeItem('pendingRegistration');
      setStep('submitted');
    }, 2000);
  }, []);

  if (step === 'submitted') {
    return (
      <div className="page">
        <ProductBanner />
        <div className="register-success">
          <div className="register-success-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h1 className="page-title">Registration Submitted</h1>
          <p className="page-desc" style={{ maxWidth: 480 }}>
            Your property registration application has been submitted for
            authorized officer review. You can track the status in the registry.
          </p>
          <div className="register-success-actions">
            <Link to="/registry" className="btn btn-primary btn-lg">View Registry</Link>
            <Link to="/dashboard" className="btn btn-ghost btn-lg">My Dashboard</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <ProductBanner />
      <div className="page-header">
        <Link to="/register" className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back to Registration Form
        </Link>
        <h1 className="page-title">Review Registration</h1>
        <p className="page-desc">
          Review your property registration details before submission. Verify all
          information is correct.
        </p>
      </div>

      <div className="review-layout">
        <div className="review-main">
          <div className="review-card">
            <div className="review-card-header">
              <h2 className="review-card-title">Property Details</h2>
              <span className="status-pill status-draft">DRAFT</span>
            </div>

            <div className="review-fields">
              <div className="review-field">
                <span className="review-field-label">Owner Name</span>
                <span className="review-field-value">{data.ownerName}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">Property ID</span>
                <span className="review-field-value">{data.propertyId}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">Property Type</span>
                <span className="review-field-value">{data.propertyType}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">Survey / Gat Number</span>
                <span className="review-field-value">{data.surveyNumber}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">Land Area</span>
                <span className="review-field-value">{data.landArea}</span>
              </div>
              {data.builderDeveloper && (
                <div className="review-field">
                  <span className="review-field-label">Builder / Developer</span>
                  <span className="review-field-value">{data.builderDeveloper}</span>
                </div>
              )}
            </div>
          </div>

          <div className="review-card">
            <div className="review-card-header">
              <h2 className="review-card-title">Location</h2>
            </div>
            <div className="review-fields">
              <div className="review-field">
                <span className="review-field-label">Address</span>
                <span className="review-field-value">{data.location}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">Village</span>
                <span className="review-field-value">{data.village}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">Taluka</span>
                <span className="review-field-value">{data.taluka}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">District</span>
                <span className="review-field-value">{data.district}</span>
              </div>
              <div className="review-field">
                <span className="review-field-label">State</span>
                <span className="review-field-value">{data.state}</span>
              </div>
            </div>
          </div>

          <div className="review-card">
            <div className="review-card-header">
              <h2 className="review-card-title">Property Value</h2>
            </div>
            <div className="review-field">
              <span className="review-field-label">Property Value</span>
              <span className="review-field-value private-badge">PRIVATE</span>
            </div>
            <p className="review-note">
              The property value is private data used only for ZK eligibility
              verification. It is never stored on the public ledger.
            </p>
          </div>
        </div>

        <div className="review-sidebar">
          <div className="review-card">
            <h2 className="review-card-title">ZK Privacy Verification</h2>
            <p className="review-sidebar-desc">
              Optionally verify eligibility before submission. This generates a
              zero-knowledge proof that property value meets the threshold without
              revealing the actual value.
            </p>
            <div className="review-sidebar-fields">
              <div className="review-sidebar-field">
                <span className="review-sidebar-label">Condition</span>
                <span className="review-sidebar-value">Value &ge; Threshold</span>
              </div>
              <div className="review-sidebar-field">
                <span className="review-sidebar-label">Threshold</span>
                <span className="review-sidebar-value">1,000,000</span>
              </div>
            </div>
            {wallet.walletState === 'connected' ? (
              <button className="btn btn-ghost" onClick={handleProofFlow} disabled={proofStep !== 'wallet-required' && proofStep !== 'error'}>
                {proofStep === 'wallet-required' ? 'Run ZK Verification' : 'Verification in Progress...'}
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={wallet.connect} disabled={wallet.walletState !== 'ready'}>
                Connect Wallet for ZK Proof
              </button>
            )}
          </div>

          {proofStep === 'generating-proof' && <ProofAnimation status="generating" />}
          {proofStep === 'verified' && (
            <ProofAnimation
              status="success"
              message={
                onChainEligible === true
                  ? 'On-chain eligibilityResult: ELIGIBLE.'
                  : onChainEligible === false
                    ? 'On-chain eligibilityResult: NOT eligible.'
                    : 'Eligibility verified via ZK proof.'
              }
            />
          )}
          {proofStep === 'error' && <ProofAnimation status="error" />}

          <div className="review-submit-section">
            <button className="btn btn-primary btn-lg review-submit-btn" onClick={handleSubmit} disabled={step === 'submitting'}>
              {step === 'submitting' ? 'Submitting...' : 'Submit for Authorized Review'}
            </button>
            <p className="review-submit-note">
              After submission, an authorized registry officer will review and
              approve or reject the registration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
