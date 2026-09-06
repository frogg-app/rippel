/**
 * Paging cursors for the library grid.
 *
 * The grid is an infinite scroll over a table that gains rows at the *top*
 * while the user reads it: every finished generation inserts one. An OFFSET
 * would then hand back rows the client has already rendered — scroll during an
 * active batch and the same image appears twice. A keyset cursor is immune: it
 * says "everything strictly older than this row", which stays true no matter
 * what arrives above it.
 *
 * The key is the composite (created_at, id). created_at alone is not unique — a
 * batch of four images from one job is inserted in one transaction and can
 * share a timestamp — so the id breaks the tie and makes the order total.
 *
 * The encoding is base64url of "<iso timestamp>|<uuid>". It is opaque on
 * purpose: clients round-trip `nextCursor` verbatim and never construct one, so
 * we stay free to change what the key is made of.
 */

export interface Cursor {
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Returns null for anything we did not produce. A bad cursor is reported to the
 * caller as invalid input rather than silently restarting the scroll at the
 * top: silently restarting is how an infinite scroll becomes infinite.
 */
export function decodeCursor(raw: string): Cursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) return null;

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!UUID.test(id)) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;

  return { createdAt, id };
}
