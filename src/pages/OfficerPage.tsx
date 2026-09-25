// PRIESTATE — AUTHORIZED OFFICER PORTAL.
//
// ⚠️ OFFICER-ONLY (rendered behind RequireOfficer). The FRONTEND role gate is a
// demo authorization (see src/auth/roles.ts): REAL government credentialing is
// out of scope. However, the approve/reject actions below are REAL on-chain
// transactions through the contract's approveRegistration / rejectRegistration
// circuits, which enforce the DESIGNATED-OFFICER model: the derived officer
// DApp public key must equal the sealed `officer` ledger key, or the circuit's
// assert fails and the transaction is rejected.
//
// Registration status is read from the REAL contract public ledger state
// (state$.registrations). PENDING/APPROVED/REJECTED is never fabricated.

import { useState, useCallback, useEffect } from 'react';
import ProductBanner from '../components/ProductBanner';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../hooks/useWallet';
import { getOfficerSecretKey } from '../secret-keys';
import {
  RegistrationStatus,
  type PriestateRegistration,
} from '../common-types';
import {
  registrationStatusLabel,
  registrationStatusClass,
  decodeDistrict,
  formatTimestamp,
} from '../registration-utils';
import type { PriestateAPI } from '../priestate-api';

function bytesToShortHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 18);
}

function hasAnyBytes(bytes: Uint8Array): boolean {
  return bytes.some((b) => b !== 0);
}

const recordsToArray = (m: ReadonlyMap<bigint, PriestateRegistration>): Array<[bigint, PriestateRegistration]> =>
  Array.from(m.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export default function OfficerPage() {
  // Shared auth wallet instance (RequireOfficer guarantees a connected one) —
  // never a second detection/connect instance.
  const { wallet } = useAuth();

  const [connectState, setConnectState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [api, setApi] = useState<PriestateAPI | null>(null);
  const [registrations, setRegistrations] = useState<ReadonlyMap<bigint, PriestateRegistration>>(new Map());

  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const selected = selectedId !== null ? registrations.get(selectedId) ?? null : null;

  useEffect(() => {
    if (wallet.walletState !== 'connected') {
      setConnectState('connecting');
      return;
    }
    let cancelled = false;
    let depSub: { unsubscribe: () => void } | undefined;
    let stateSub: { unsubscribe: () => void } | undefined;

    const threshold = 1000000n;
    const deployment$ = wallet.manager.resolve(undefined, threshold);
    depSub = deployment$.subscribe({
      next: (d) => {
        if (cancelled) return;
        if (d.status === 'deployed') {
          setApi(d.api);
          setConnectState('connected');
          setConnectError(null);
          stateSub = d.api.state$.subscribe((s) => {
            if (!cancelled) setRegistrations(s.registrations);
          });
        } else if (d.status === 'failed') {
          setConnectState('failed');
          setConnectError(d.error.message);
        }
      },
      error: (e: unknown) => {
        if (!cancelled) {
          setConnectState('failed');
          setConnectError(describeError(e));
        }
      },
    });

    return () => {
      cancelled = true;
      depSub?.unsubscribe();
      stateSub?.unsubscribe();
    };
  }, [wallet, wallet.walletState]);

  const performAction = useCallback(
    (action: 'approve' | 'reject') => {
      if (!api || selectedId === null || busy) return;
      setBusy(true);
      setActionError(null);
      setActionResult(null);
      void (async () => {
        try {
          const reviewedAt = BigInt(Date.now());
          if (action === 'approve') {
            await api.approveRegistration(getOfficerSecretKey(), selectedId, reviewedAt);
            setActionResult('Registration APPROVED on-chain.');
          } else {
            await api.rejectRegistration(getOfficerSecretKey(), selectedId, reviewedAt);
            setActionResult('Registration REJECTED on-chain.');
          }
          setSelectedId(null);
        } catch (e: unknown) {
          setActionError(`On-chain ${action} failed: ${describeError(e)}`);
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, selectedId, busy],
  );

  const records = recordsToArray(registrations);
  const pendingCount = records.filter(([, r]) => r.status === RegistrationStatus.PENDING).length;
  const approvedCount = records.filter(([, r]) => r.status === RegistrationStatus.APPROVED).length;
  const rejectedCount = records.filter(([, r]) => r.status === RegistrationStatus.REJECTED).length;

  return (
    <div className="page officer-page">
      <ProductBanner />

      <div className="officer-banner" role="status">
        <div className="officer-banner-inner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span className="officer-banner-label">AUTHORIZED OFFICER PORTAL</span>
          <span className="officer-banner-text">
            Approve/reject are real on-chain transactions gated by the
            designated-officer circuit. The frontend role gate is a demo UI
            control; real government credentialing is out of scope.
          </span>
        </div>
      </div>

      <div className="page-header">
        <h1 className="page-title">AUTHORIZED OFFICER PORTAL</h1>
        <p className="page-desc">
          Review on-chain property registrations and record an authorized
          approve/reject decision. Status below is read from the contract&apos;s
          public ledger state — never fabricated.
        </p>
      </div>

      {actionResult && <div className="status-msg success officer-action-result">{actionResult}</div>}
      {actionError && <div className="status-msg error officer-action-result">{actionError}</div>}

      {connectState !== 'connected' && (
        <div className="officer-stats">
          <div className="officer-stat">
            <span className="officer-stat-label">
              {connectState === 'connecting' ? 'Connecting to contract…' : 'Contract unavailable'}
            </span>
          </div>
        </div>
      )}

      {connectState === 'failed' && (
        <div className="status-msg error" role="alert">{connectError}</div>
      )}

      {connectState === 'connected' && (
        <>
          <div className="officer-stats">
            <div className="officer-stat">
              <span className="officer-stat-value">{pendingCount}</span>
              <span className="officer-stat-label">Pending Review</span>
            </div>
            <div className="officer-stat">
              <span className="officer-stat-value">{approvedCount}</span>
              <span className="officer-stat-label">Approved</span>
            </div>
            <div className="officer-stat">
              <span className="officer-stat-value">{rejectedCount}</span>
              <span className="officer-stat-label">Rejected</span>
            </div>
          </div>

          {selectedId !== null && selected ? (
            <div className="officer-detail">
              <button className="back-link" onClick={() => setSelectedId(null)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
                Back to Registrations
              </button>

              <div className="officer-detail-card">
                <div className="officer-detail-header">
                  <div>
                    <h2 className="officer-detail-title">Registration {selectedId.toString()}</h2>
                    <p className="officer-detail-ref">Owner key {bytesToShortHex(selected.owner)}…</p>
                  </div>
                  <div className="officer-detail-badges">
                    <span className={`status-pill ${registrationStatusClass(selected.status)}`}>
                      {registrationStatusLabel(selected.status).replace('_', ' ')}
                    </span>
                  </div>
                </div>

                <div className="officer-detail-grid">
                  <div className="officer-detail-section">
                    <h3 className="officer-detail-section-title">Registration</h3>
                    <div className="officer-detail-fields">
                      <div className="officer-detail-field">
                        <span className="officer-detail-label">Area</span>
                        <span className="officer-detail-value">{selected.area.toString()}</span>
                      </div>
                      <div className="officer-detail-field">
                        <span className="officer-detail-label">District</span>
                        <span className="officer-detail-value">{decodeDistrict(selected.district)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="officer-detail-section">
                    <h3 className="officer-detail-section-title">Timeline</h3>
                    <div className="officer-detail-fields">
                      <div className="officer-detail-field">
                        <span className="officer-detail-label">Submitted</span>
                        <span className="officer-detail-value">{formatTimestamp(selected.submittedAt)}</span>
                      </div>
                      <div className="officer-detail-field">
                        <span className="officer-detail-label">Reviewed</span>
                        <span className="officer-detail-value">{formatTimestamp(selected.reviewedAt)}</span>
                      </div>
                      <div className="officer-detail-field">
                        <span className="officer-detail-label">Reviewed By</span>
                        <span className="officer-detail-value">{hasAnyBytes(selected.reviewedBy) ? bytesToShortHex(selected.reviewedBy) + '…' : '—'}</span>
                      </div>
                    </div>
                  </div>

                  <div className="officer-detail-section">
                    <h3 className="officer-detail-section-title">Privacy</h3>
                    <div className="officer-detail-fields">
                      <div className="officer-detail-field">
                        <span className="officer-detail-label">Property Value</span>
                        <span className="officer-detail-value private-badge">PRIVATE</span>
                      </div>
                      <p className="officer-notes-text">
                        The property value is never stored on the ledger and is
                        never displayed here.
                      </p>
                    </div>
                  </div>
                </div>

                {selected.status === RegistrationStatus.PENDING ? (
                  <div className="officer-actions">
                    <button className="btn btn-primary officer-approve-btn" onClick={() => performAction('approve')} disabled={busy}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      {busy ? 'Submitting…' : 'Approve Registration'}
                    </button>
                    <button className="btn btn-danger officer-reject-btn" onClick={() => performAction('reject')} disabled={busy}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                      {busy ? 'Submitting…' : 'Reject Registration'}
                    </button>
                  </div>
                ) : (
                  <div className="officer-actions officer-actions-finalized">
                    <p className="officer-notes-text">
                      This registration is finalized on-chain and cannot be
                      re-reviewed.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="officer-table-wrap">
              {records.length === 0 ? (
                <div className="officer-table-empty">
                  No on-chain registrations recorded yet. Submissions from the
                  owner flow will appear here from the contract ledger.
                </div>
              ) : (
                <table className="officer-table" role="table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Owner</th>
                      <th>Area</th>
                      <th>District</th>
                      <th>Status</th>
                      <th>Submitted</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(([id, p]) => (
                      <tr key={id.toString()}>
                        <td className="officer-td-mono">{id.toString()}</td>
                        <td className="officer-td-mono">{bytesToShortHex(p.owner)}…</td>
                        <td>{p.area.toString()}</td>
                        <td>{decodeDistrict(p.district)}</td>
                        <td>
                          <span className={`status-pill ${registrationStatusClass(p.status)}`}>
                            {registrationStatusLabel(p.status).replace('_', ' ')}
                          </span>
                        </td>
                        <td>{formatTimestamp(p.submittedAt)}</td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => setSelectedId(id)}>Review</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      <div className="officer-footer-note">
        <p>
          Legal ownership and government records remain authoritative off-chain.
          Officer approve/reject authorization is enforced on-chain by the
          designated-officer circuit.
        </p>
      </div>
    </div>
  );
}
