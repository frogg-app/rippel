import { useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertIcon } from '../components/icons';
import { Lockup } from '../components/Mark';
import { RippleBackdrop } from '../components/RippleBackdrop';
import { SIGN_IN_WAVE, SINK_MS, fail, sink, surface } from '../components/surface';
import { useAuth } from '../auth/context';
import { ApiRequestError } from '../lib/api';
import { validateAuth, type FieldErrors } from './auth-validation';
import styles from './AuthPage.module.css';

type Mode = 'login' | 'register';

/**
 * Sign in and sign up, one component because they differ by two fields and a
 * verb. Validation deliberately stays thin (see auth-validation.ts), and is
 * done here rather than by the browser (`noValidate`): the native tooltips are
 * off-brand, and blocking submit natively would skip the failure animation.
 */
export function AuthPage({ mode }: { mode: Mode }) {
  const { signIn, signUp, allowRegistration } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fieldId = useId();
  const cardRef = useRef<HTMLFormElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const invalid = validateAuth({ email, password });
    setFieldErrors(invalid);
    const first = invalid.email ? 'email' : invalid.password ? 'password' : null;
    if (first) {
      document.getElementById(`${fieldId}-${first}`)?.focus();
      if (cardRef.current) fail(cardRef.current);
      return;
    }
    setBusy(true);
    // Hold the signed-in redirect from before the request: it would otherwise
    // race the sink below the moment the session lands. Released on failure.
    surface.set('sinking');
    try {
      if (isRegister) {
        await signUp({
          email,
          password,
          displayName: displayName.trim() === '' ? undefined : displayName.trim(),
        });
      } else {
        await signIn({ email, password });
      }
      // Signed in: a beat, then the card sinks as a big wave goes out from
      // it; then route on and let the app rise (see components/surface.tsx).
      // A sink that fails (the card went away) must not strand the user here.
      const goingUnder = () => {
        surface.water().outlineWave(performance.now(), SIGN_IN_WAVE);
        // The drifting glow goes with the card, so what is left when this page
        // unmounts is only the ground and ambient light the app shell has too.
        glowRef.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: SINK_MS, easing: 'ease-in-out', fill: 'forwards' });
      };
      if (cardRef.current) await sink(cardRef.current, goingUnder).catch(() => {});
      // Back to whatever they were trying to reach before the gate sent them
      // here, or the creation surface if they came in cold.
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/create', { replace: true });
      surface.set('rising');
    } catch (cause) {
      surface.set('idle');
      if (cardRef.current) fail(cardRef.current);
      setError(
        cause instanceof ApiRequestError ? cause.message : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page} onMouseDown={preventWaterSelection}>
      <div ref={glowRef} className={styles.glow} aria-hidden />
      {/* The water: centre drops, click ripples and the cursor's wake; signing
          in sends waves from the card's edge (components/surface.tsx). */}
      <RippleBackdrop className={styles.water} shape={cardRef} water={surface.water()} />
      <form ref={cardRef} className={styles.card} noValidate onSubmit={(event) => void onSubmit(event)}>
        <header className={styles.head}>
          {/* The lockup is the heading here — the name is the only title this
              screen needs, and the subtitle carries sign-in versus sign-up. */}
          <h1 className={styles.title}>
            <Lockup size={34} />
          </h1>
          <p className={styles.subtitle}>
            {isRegister
              ? 'Create an account. Your library and your generations are private to it.'
              : 'Sign in to your generations.'}
          </p>
        </header>

        <div className={styles.fields}>
          {isRegister ? (
            <Field
              id={`${fieldId}-name`}
              label="Display name"
              hint="Optional"
              value={displayName}
              onChange={setDisplayName}
              autoComplete="nickname"
            />
          ) : null}

          <Field
            id={`${fieldId}-email`}
            label="Email"
            type="email"
            value={email}
            onChange={(value) => {
              setEmail(value);
              // Typing clears the field's complaint; it is checked again on submit.
              if (fieldErrors.email) setFieldErrors(({ email: _, ...rest }) => rest);
            }}
            error={fieldErrors.email}
            autoComplete="email"
            required
            autoFocus={!isRegister}
          />

          <Field
            id={`${fieldId}-password`}
            label="Password"
            type="password"
            value={password}
            onChange={(value) => {
              setPassword(value);
              if (fieldErrors.password) setFieldErrors(({ password: _, ...rest }) => rest);
            }}
            error={fieldErrors.password}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
          />
        </div>

        {/* Announced, because a failed sign-in that only changes colour is
            invisible to a screen reader. */}
        {error ? (
          <div className={styles.error} role="alert">
            <AlertIcon size={15} className={styles.errorIcon} />
            <span>{error}</span>
          </div>
        ) : null}

        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? 'One moment…' : isRegister ? 'Create account' : 'Sign in'}
        </button>

        <div className={styles.alt}>
          {isRegister ? (
            <>
              Already have an account? <Link to="/login">Sign in</Link>
            </>
          ) : allowRegistration ? (
            <>
              New here? <Link to="/register">Create an account</Link>
            </>
          ) : (
            // ALLOW_REGISTRATION=false on a server that already has a user.
            <span className={styles.closed}>Registration is closed on this server.</span>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * A double or triple click on the water would select whatever is nearest and
 * pop up a selection toolbar. The card and its fields keep normal selection.
 */
function preventWaterSelection(event: MouseEvent<HTMLDivElement>) {
  if (event.detail < 2) return;
  const target = event.target;
  if (target instanceof Element && target.closest('form, input, textarea, [contenteditable]')) return;
  event.preventDefault();
}

function Field({
  id,
  label,
  hint,
  type = 'text',
  value,
  onChange,
  error,
  ...rest
}: {
  id: string;
  label: string;
  hint?: string;
  /** Shown under the input, and marks it invalid. */
  error?: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        <span className="label">{label}</span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </label>
      <input
        id={id}
        className={styles.input}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...rest}
      />
      {error ? (
        <p id={`${id}-error`} className={styles.fieldError}>
          <AlertIcon size={13} className={styles.errorIcon} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
