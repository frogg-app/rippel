import { useState } from 'react';
import type { Collection } from '../lib/api-library';
import type { CollectionsState } from './useCollections';
import { FolderIcon, LayersIcon, PlusIcon, StarIcon } from './icons';
import styles from './CollectionsRail.module.css';

/**
 * The collections sidebar.
 *
 * Two fixed views at the top — everything, and starred — then the user's own
 * collections. Creating one is an inline field rather than a modal: it takes a
 * name and nothing else, and a dialog for a single text input is ceremony.
 * There is deliberately no rename, delete or reorder here; the brief asks for a
 * list and a menu, not a management screen.
 */
export function CollectionsRail({
  collections,
  loading,
  activeCollectionId,
  starredOnly,
  onSelectAll,
  onSelectStarred,
  onSelectCollection,
  onCreate,
}: {
  collections: Collection[];
  loading: boolean;
  activeCollectionId: string | null;
  starredOnly: boolean;
  onSelectAll: () => void;
  onSelectStarred: () => void;
  onSelectCollection: (collection: Collection) => void;
  onCreate: CollectionsState['create'];
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const showingEverything = !activeCollectionId && !starredOnly;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const created = await onCreate(name);
    if (created) {
      setName('');
      setAdding(false);
    }
  }

  return (
    <nav className={styles.rail} aria-label="Collections">
      <ul className={styles.list}>
        <li>
          <button
            type="button"
            className={`${styles.item} ${showingEverything ? styles.itemOn : ''}`}
            aria-current={showingEverything}
            onClick={onSelectAll}
          >
            <LayersIcon size={15} />
            Everything
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`${styles.item} ${starredOnly ? styles.itemOn : ''}`}
            aria-current={starredOnly}
            onClick={onSelectStarred}
          >
            <StarIcon size={15} filled={starredOnly} />
            Starred
          </button>
        </li>
      </ul>

      <div className={styles.sectionHead}>
        <span className="label">Collections</span>
        <button
          type="button"
          className={styles.add}
          onClick={() => setAdding((open) => !open)}
          aria-label="New collection"
          aria-expanded={adding}
        >
          <PlusIcon size={14} />
        </button>
      </div>

      {adding ? (
        <form className={styles.form} onSubmit={submit}>
          <input
            className={styles.field}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name"
            aria-label="Collection name"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAdding(false);
            }}
          />
        </form>
      ) : null}

      {loading ? (
        <p className={styles.hint}>Loading…</p>
      ) : collections.length === 0 ? (
        <p className={styles.hint}>
          No collections yet. They are a way to keep a set of renders together.
        </p>
      ) : (
        <ul className={styles.list}>
          {collections.map((collection) => {
            const active = collection.id === activeCollectionId;
            return (
              <li key={collection.id}>
                <button
                  type="button"
                  className={`${styles.item} ${active ? styles.itemOn : ''}`}
                  aria-current={active}
                  onClick={() => onSelectCollection(collection)}
                >
                  <FolderIcon size={15} />
                  <span className={styles.name}>{collection.name}</span>
                  <span className={`mono ${styles.badge}`}>{collection.assetCount}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
