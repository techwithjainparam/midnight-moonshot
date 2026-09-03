import {
  LOGIN_FACTOR_ORDER,
  LOGIN_FACTOR_LABELS,
  snapshotLoginFactorState,
  type LoginSnapshot,
  type LoginFactor,
} from '../auth/account-types';

// PRIESTATE — Login authentication stepper (Level 3 Part 5).
//
// Presents the sequential login authentication factors
// (Wallet → Google → SMS OTP → WhatsApp OTP → Complete). Pure presentational:
// it never stores or transmits a secret — it only reflects the server-provided
// login snapshot, capability flags and which factor is currently in progress.
// Only the current required factor is actionable; everything else is rendered
// as done / pending / unavailable.

interface LoginStepperProps {
  /** Server-authoritative login factor state (null while unknown). */
  readonly snapshot: LoginSnapshot | null;
  /** Whether each external factor channel is configured on the server. */
  readonly configured: { google: boolean; sms: boolean; whatsapp: boolean };
  /** Whether a factor step is actively in progress (spinner state). */
  readonly busyFactor?: LoginFactor | null;
  /** Optional inline message for the current step (errors/cooldown/notes). */
  readonly message?: string | null;
  /** Whether the user is in the terminal (password) step. */
  readonly completing?: boolean;
}

type StepState = 'done' | 'active' | 'pending' | 'unavailable';

export default function LoginStepper({
  snapshot,
  configured,
  busyFactor = null,
  message,
  completing = false,
}: LoginStepperProps) {
  const states = snapshotLoginFactorState(snapshot);
  const allReady = Boolean(snapshot && snapshot.allFactorsReady);

  const factorStepState = (f: LoginFactor): StepState => {
    if (f === 'wallet') {
      // Wallet is verified the moment an account exists for a connected wallet.
      return states.wallet ? 'done' : 'active';
    }
    const configuredFlag = f === 'google' ? configured.google : f === 'sms' ? configured.sms : configured.whatsapp;
    if (!configuredFlag) return 'unavailable';
    if (states[f]) return 'done';
    if (busyFactor === f) return 'active';
    if (snapshot && snapshot.nextPendingFactor === f) return 'active';
    return 'pending';
  };

  // The terminal Complete step becomes active only when every factor holds.
  const completeActive = allReady && completing;
  const completeState: 'active' | 'pending' = completeActive ? 'active' : 'pending';
  const completeLabel = 'Complete';

  return (
    <div className="registration-stepper" aria-label="Login authentication progress">
      <div className="registration-steps">
        {LOGIN_FACTOR_ORDER.map((f, i) => {
          const s = factorStepState(f);
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
                {i < LOGIN_FACTOR_ORDER.length - 1 && <div className="registration-step-line" />}
              </div>
              <span className="registration-step-label">{label(f)}</span>
            </div>
          );
        })}

        {/* Terminal Complete step */}
        <div key="complete" className={`registration-step ${completeState}`}>
          <div className="registration-step-indicator">
            <div className="registration-step-dot">
              {completeState === 'active' && <div className="registration-step-pulse" />}
              {completeState === 'pending' && <span className="registration-step-num">{LOGIN_FACTOR_ORDER.length + 1}</span>}
            </div>
          </div>
          <span className="registration-step-label">{completeLabel}</span>
        </div>
      </div>

      {allReady && !completing && (
        <div className="status-msg success" role="status">
          All required login factors are verified. Enter your password to complete login.
        </div>
      )}
      {message && !allReady && (
        <div className="status-msg" role="status">
          {message}
        </div>
      )}
    </div>
  );
}

function label(f: LoginFactor): string {
  return LOGIN_FACTOR_LABELS[f];
}