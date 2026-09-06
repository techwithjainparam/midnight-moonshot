import {
  REGISTRATION_FACTOR_ORDER,
  REGISTRATION_FACTOR_LABELS,
  snapshotFactorState,
  type RegistrationSnapshot,
  type RegistrationFactor,
} from '../auth/account-types';

export type RegistrationStepState = 'done' | 'active' | 'pending' | 'unavailable';

// PRIESTATE — Registration authentication stepper (Level 3 Part 3).
//
// Presents the sequential registration authentication factors
// (Wallet → Google → SMS OTP → WhatsApp OTP) with an explicit completed /
// pending / unavailable state per factor. Pure presentational: it never
// stores or transmits any secret — it only reflects the server-provided
// registration snapshot and capability flags.

interface RegistrationStepperProps {
  /** Server-authoritative registration factor state (null while unknown). */
  readonly snapshot: RegistrationSnapshot | null;
  /** Whether each external factor channel is configured on the server. */
  readonly configured: { google: boolean; sms: boolean; whatsapp: boolean };
  /** Whether a factor step is actively in progress (spinner state). */
  readonly busyFactor?: RegistrationFactor | null;
  /** Optional inline message for the current step (errors/cooldown/notes). */
  readonly message?: string | null;
  /**
   * Optional subsequent identity stages (password/camera/liveness/location/
   * completion) rendered after the authentication factors so the complete
   * registration journey is visible as one sequential stepper.
   */
  readonly identityStages?: ReadonlyArray<{ label: string; state: RegistrationStepState }>;
}

export default function RegistrationStepper({
  snapshot,
  configured,
  busyFactor = null,
  message,
  identityStages,
}: RegistrationStepperProps) {
  const states = snapshotFactorState(snapshot);
  const complete = Boolean(snapshot && snapshot.complete);

  const stepState = (f: RegistrationFactor): RegistrationStepState => {
    if (f === 'wallet') {
      // Wallet is verified the moment a wallet is connected for an account.
      return states.wallet ? 'done' : 'active';
    }
    const configuredFlag = f === 'google' ? configured.google : f === 'sms' ? configured.sms : configured.whatsapp;
    if (!configuredFlag) return 'unavailable';
    if (states[f]) return 'done';
    if (busyFactor === f) return 'active';
    if (snapshot && snapshot.nextPendingFactor === f) return 'active';
    return 'pending';
  };

  const label = (f: RegistrationFactor): string => REGISTRATION_FACTOR_LABELS[f];

  return (
    <div className="registration-stepper" aria-label="Registration authentication progress">
      <div className="registration-steps">
        {REGISTRATION_FACTOR_ORDER.map((f, i) => {
          const s = stepState(f);
          const cls = `registration-step ${s}`;
          return (
            <div key={f} className={cls}>
              <div className="registration-step-indicator">
                <div className="registration-step-dot">
                  {s === 'done' && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  {s === 'active' && <div className="registration-step-pulse" />}
                  {s === 'unavailable' && <span className="registration-step-x">×</span>}
                  {s === 'pending' && <span className="registration-step-num">{i + 1}</span>}
                </div>
                {i < REGISTRATION_FACTOR_ORDER.length - 1 && <div className="registration-step-line" />}
              </div>
              <span className="registration-step-label">{label(f)}</span>
            </div>
          );
        })}
      </div>

      {identityStages && identityStages.length > 0 && (
        <div className="registration-steps registration-steps-identity">
          {identityStages.map((s, i) => {
            const cls = `registration-step ${s.state}`;
            const isLast = i === identityStages.length - 1;
            return (
              <div key={s.label} className={cls}>
                <div className="registration-step-indicator">
                  <div className="registration-step-dot">
                    {s.state === 'done' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {s.state === 'active' && <div className="registration-step-pulse" />}
                    {s.state === 'unavailable' && <span className="registration-step-x">×</span>}
                    {s.state === 'pending' && <span className="registration-step-num">{i + 1}</span>}
                  </div>
                  {!isLast && <div className="registration-step-line" />}
                </div>
                <span className="registration-step-label">{s.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {complete && (
        <div className="status-msg success" role="status">
          All registration authentication factors verified — your account is ready.
        </div>
      )}
      {message && !complete && (
        <div className="status-msg" role="status">
          {message}
        </div>
      )}
    </div>
  );
}
