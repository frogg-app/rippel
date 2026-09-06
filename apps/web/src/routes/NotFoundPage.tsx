import { Link } from 'react-router-dom';

/** Inside the shell, so the status pill stays answerable even when lost. */
export function NotFoundPage() {
  return (
    <div
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--gap-sm)',
        color: 'var(--text-muted)',
      }}
    >
      <p className="serif" style={{ fontSize: 'var(--display)', color: 'var(--text-3)', margin: 0 }}>
        Nothing here
      </p>
      <Link to="/create">Back to Create</Link>
    </div>
  );
}
