import { useId, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Mark } from '../components/Mark';
import { useAuth } from '../auth/context';
import { ApiRequestError } from '../lib/api';
import styles from './AuthPage.module.css';

type Mode = 'login' | 'register';

/**
 * Sign in and sign up, one component because they differ by two fields and a
 * verb. Validation deliberately stays thin: the API is the authority on what a
 * valid password is (10 characters, per its zod schema) and duplicating that
 * rule here is how the two drift apart. The client checks only what it can know
 * without asking — that the fields are filled in.
 */
export function AuthPage({ mode }: { mode: Mode }) {
  const { signIn, signUp, allowRegistration } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fieldId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
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
      // Back to whatever they were trying to reach before the gate sent them
      // here, or the creation surface if they came in cold.
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/create', { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.glow} aria-hidden />
      <form className={styles.card} onSubmit={(event) => void onSubmit(event)}>
        <header className={styles.head}>
          <Mark size={34} />
          <h1 className={`serif ${styles.title}`}>{isRegister ? 'Create your studio' : 'Studio'}</h1>
          <p className={styles.subtitle}>
            {isRegister
              ? 'Your library and your generations are private to this account.'
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
            onChange={setEmail}
            autoComplete="email"
            required
            autoFocus={!isRegister}
          />

          <Field
            id={`${fieldId}-password`}
            label="Password"
            type="password"
            hint={isRegister ? 'At least 10 characters' : undefined}
            value={password}
            onChange={setPassword}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
          />
        </div>

        {/* Announced, because a failed sign-in that only changes colour is
            invisible to a screen reader. */}
        {error ? (
          <div className={styles.error} role="alert">
            {error}
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

function Field({
  id,
  label,
  hint,
  type = 'text',
  value,
  onChange,
  ...rest
}: {
  id: string;
  label: string;
  hint?: string;
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
        {...rest}
      />
    </div>
  );
}
