import { useEffect, useState } from 'react';
import type { ManagedUser } from '@comfy/shared';
import { usersApi, type UsersApi, type UserPermissions } from '../lib/api-users';
import { Dropdown } from '../components/Dropdown';
import { DeleteButton } from '../components/ConfirmDelete';
import { ChevronDownIcon } from '../components/icons';
import styles from './UsersSection.module.css';
export function UsersSection({ currentUserId, api = usersApi }: { currentUserId?: string; api?: UsersApi }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    api.list(controller.signal).then(rows => { if (!controller.signal.aborted) setUsers(rows); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load users.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, reload]);
  async function add(form: HTMLFormElement) {
    const fields = new FormData(form); setBusy(true); setError(null);
    try {
      const user = await api.create({ email: String(fields.get('email')), displayName: String(fields.get('displayName')), password: String(fields.get('password')) });
      setUsers(previous => [...previous, user]); setAdding(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create user.'); }
    finally { setBusy(false); }
  }
  return <section className={styles.section}>
    <p>Administrators manage users and the whole app. Backend settings access lets a regular user manage machines without managing other accounts.</p>
    <button onClick={() => setAdding(value => !value)} disabled={busy}>{adding ? 'Cancel new user' : 'Add user'}</button>
    {adding && <form className={styles.card} onSubmit={event => { event.preventDefault(); void add(event.currentTarget); }}>
      <label>Email<input type="email" name="email" required maxLength={254} autoComplete="off" /></label>
      <label>Display name<input name="displayName" maxLength={60} /></label>
      <label>Password<input type="password" name="password" required maxLength={200} autoComplete="new-password" /></label>
      <p>New accounts start as regular users with generation enabled and no limits.</p>
      <button disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
    </form>}
    {error && <div role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Reload users</button></div>}
    {loading ? <p role="status">Loading users…</p> : users.map(user => <UserEditor key={user.id} user={user} own={user.id === currentUserId} api={api} onDeleted={() => setUsers(previous => previous.filter(row => row.id !== user.id))} onSaved={updated => {
      setUsers(previous => previous.map(row => row.id === updated.id ? { ...updated, activeJobs: row.activeJobs, generationsToday: row.generationsToday } : row));
      if (updated.id === currentUserId && (updated.suspended || updated.role !== 'admin')) window.location.reload();
    }} />)}
  </section>;
}
function UserEditor({ user, own, api, onSaved, onDeleted }: { onDeleted: () => void; user: ManagedUser; own: boolean; api: UsersApi; onSaved: (user: ManagedUser) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<UserPermissions>(() => ({ role: user.role, settingsAccess: user.settingsAccess, suspended: user.suspended, generationEnabled: user.generationEnabled, maxQueuedJobs: user.maxQueuedJobs, dailyGenerationLimit: user.dailyGenerationLimit }));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setMessage(null); setError(null);
    try { onSaved(await api.update(user.id, draft)); setMessage('Saved.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save user.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    try { await api.remove(user.id); }
    catch (cause) { throw new Error(cause instanceof Error ? cause.message : 'Could not delete user.'); }
    onDeleted();
  }
  return <article className={styles.userRow}>
    <button type="button" className={styles.userSummary} aria-expanded={expanded} aria-controls={`user-${user.id}`} onClick={() => setExpanded(value => !value)}>
      <span className={styles.identity}><strong>{user.displayName || user.email}{own ? ' (you)' : ''}</strong>{user.displayName && <span>{user.email}</span>}</span>
      <span className={styles.overview}><span>{user.role === 'admin' ? 'Administrator' : user.settingsAccess ? 'User · Backend settings' : 'User'} · {user.suspended ? 'Suspended' : user.generationEnabled ? 'Active' : 'Generation disabled'}</span><span>{user.queuedJobs ?? 0}{user.maxQueuedJobs !== null ? `/${user.maxQueuedJobs}` : ''} queued · {user.generationsToday}{user.dailyGenerationLimit !== null ? `/${user.dailyGenerationLimit}` : ''} today</span></span>
      <ChevronDownIcon size={16} className={expanded ? styles.expanded : undefined} />
    </button>
    {expanded && <form id={`user-${user.id}`} className={styles.card} aria-label={`Permissions for ${user.email}`} onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy}>
      <label>Role<Dropdown aria-label="Role" value={draft.role} disabled={busy} options={[{value:'user',label:'User'},{value:'admin',label:'Administrator'}]} onChange={role => setDraft({ ...draft, role: role as 'admin' | 'user' })} /></label>
      <label className={styles.check}><input type="checkbox" checked={draft.role === 'admin' || draft.settingsAccess} disabled={draft.role === 'admin'} onChange={event => setDraft({ ...draft, settingsAccess: event.target.checked })} />Backend settings access</label>
      <label className={styles.check}><input type="checkbox" checked={draft.generationEnabled} onChange={event => setDraft({ ...draft, generationEnabled: event.target.checked })} />Allow new generations</label>
      <label className={styles.check}><input type="checkbox" checked={draft.suspended} onChange={event => setDraft({ ...draft, suspended: event.target.checked })} />Suspend account</label>
      <div className={styles.limits}>
        <label>Queued job limit<input type="number" min={1} max={10000} step={1} placeholder="Unlimited" value={draft.maxQueuedJobs ?? ''} onChange={event => setDraft({ ...draft, maxQueuedJobs: event.target.value === '' ? null : Number(event.target.value) })} /></label>
        <label>Daily generation limit<input type="number" min={1} max={1000000} step={1} placeholder="Unlimited" value={draft.dailyGenerationLimit ?? ''} onChange={event => setDraft({ ...draft, dailyGenerationLimit: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      </div>
      <p>{user.activeJobs} active jobs · {user.generationsToday} generations submitted today. The queue limit counts waiting jobs only; running jobs do not count. Daily limits count each requested image or video, including batches, and reset at midnight UTC.</p>
      <p>Blank limits mean unlimited. Suspending signs the user out. Turning off generation blocks new requests; already submitted jobs finish normally. Cancellation does not refund daily usage.</p>
      <button>{busy ? 'Saving…' : 'Save permissions'}</button>
    </fieldset>
    {!own && <div className={styles.deleteArea}>
      <p>Deleting removes their account, sessions, job history, collections and library records. Stored files stay on disk.</p>
      <DeleteButton size="md" label="Delete user" disabled={busy} confirmTitle="Delete this user?" confirmBody={<><strong>{user.email}</strong> will be deleted for good. This cannot be undone.</>} onConfirm={remove} />
    </div>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </form>}
  </article>;
}
