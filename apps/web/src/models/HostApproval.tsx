import { useEffect, useRef, useState } from 'react';
import type { ModelInstall } from '@comfy/shared';
import type { ModelsApi } from '../lib/api-models';
import { Button } from '../components/Button';
import styles from './HostApproval.module.css';

export function HostApproval({ installs, api }: { installs: ModelInstall[]; api: ModelsApi }) {
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [later, setLater] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = installs.find(i => i.approvalRequired && !handled.has(`${i.id}:${i.approvalRequired.hostname}`));
  const hostname = pending?.approvalRequired?.hostname;
  const key = pending && hostname ? `${pending.id}:${hostname}` : null;
  const open = !!key && key !== later;
  useEffect(() => {
    setError(null);
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [key, open]);
  async function decide(approve: boolean) {
    if (!pending || !hostname || !key || !api.approveHost || busy) return;
    setBusy(true); setError(null);
    try {
      await api.approveHost(pending.backendId, pending.id, hostname, approve);
      setHandled(previous => new Set(previous).add(key));
    } catch {
      setError('Could not save your choice. Try again.');
    } finally { setBusy(false); }
  }
  return <>
    {key && !open ? <Button size="md" className={styles.review} onClick={() => setLater(null)}>Download paused · Review host</Button> : null}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="host-approval-title"
      onCancel={event => { event.preventDefault(); if (!busy) setLater(key); }}>
      <h2 id="host-approval-title">Approve download host?</h2>
      <p><strong>{pending?.displayName}</strong> needs to download from:</p>
      <div className={styles.hostname}>{hostname}</div>
      <p>Approving lets this backend use this host for future model downloads too.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <Button size="md" variant="quiet" disabled={busy} onClick={() => setLater(key)}>Later</Button>
        <Button size="md" disabled={busy} onClick={() => void decide(false)}>Deny</Button>
        <Button size="md" variant="primary" busy={busy} onClick={() => void decide(true)}>{busy ? 'Saving…' : 'Approve host'}</Button>
      </div>
    </dialog>
  </>;
}
