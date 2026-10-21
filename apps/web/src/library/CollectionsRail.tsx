import { useState, type ReactNode } from 'react';
import type { Collection, LibraryView } from '../lib/api-library';
import type { CollectionsState } from './useCollections';
import {
  ArchiveIcon,
  FolderIcon,
  LayersIcon,
  PersonIcon,
  PlusIcon,
  SharedIcon,
  StarIcon,
} from './icons';
import styles from './CollectionsRail.module.css';

/**
 * The collections sidebar.
 *
 * Fixed views at the top — everything (yours and what was shared with you),
 * your own, starred, shared with you, and the archive — then the user's own
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
  view,
  onSelectView,
  onSelectStarred,
  onSelectCollection,
  onCreate,
}: {
  collections: Collection[];
  loading: boolean;
  activeCollectionId: string | null;
  starredOnly: boolean;
  view: LibraryView;
  onSelectView: (view: LibraryView) => void;
  onSelectStarred: () => void;
  onSelectCollection: (collection: Collection) => void;
  onCreate: CollectionsState['create'];
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  // A view is "on" only when nothing narrower is: a collection or Starred
  // replaces it as the thing the grid is showing.
  const viewOn = (candidate: LibraryView) =>
    view === candidate && !activeCollectionId && !starredOnly;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const created = await onCreate(name);
    if (created) {
      setName('');
      setAdding(false);
    }
  }

  const item = (key: string, on: boolean, onClick: () => void, icon: ReactNode, label: string) => (
    <li key={key}>
      <button
        type="button"
        className={`${styles.item} ${on ? styles.itemOn : ''}`}
        aria-current={on}
        onClick={onClick}
      >
        {icon}
        {label}
      </button>
    </li>
  );

  return (
    <nav className={styles.rail} aria-label="Library">
      <ul className={styles.list}>
        {item('everything', viewOn('everything'), () => onSelectView('everything'), <LayersIcon size={15} />, 'Everything')}
        {item('mine', viewOn('mine'), () => onSelectView('mine'), <PersonIcon size={15} />, 'My stuff')}
        {item('starred', starredOnly, onSelectStarred, <StarIcon size={15} filled={starredOnly} />, 'Starred')}
        {item('shared', viewOn('shared'), () => onSelectView('shared'), <SharedIcon size={15} />, 'Shared with me')}
        {item('archived', viewOn('archived'), () => onSelectView('archived'), <ArchiveIcon size={15} />, 'Archived')}
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
