/**
 * The Models screen (PLAN.md §4 phase 6).
 *
 * Layout from `design/parts/ModelBrowser.body.html`: a 60px band with the display
 * title, a tab strip carrying live counts, and a status pill on the right; then
 * a search-and-chips band; then the content. Three deviations from the artboard,
 * each forced by what the API can actually say, each noted where it happens:
 *
 *  - The catalogue combines backend install offers with cached Hugging Face
 *    repositories. Discovery-only repositories remain visible, with explicit
 *    access/setup requirements; only exact backend offers can be installed.
 *  - The artboard's cards are photographs with a percentage bar. There is now a
 *    photograph on about half of them — the API resolves each entry's model page
 *    and serves a cached sample image — but never a percentage: the transport
 *    reports tasks, not bytes. See CatalogueCard and InstallProgress.
 *  - 42 base families is a select on Installed, not a chip row. See FilterBar.
 *    Discover has outgrown that band: its filters are a facet rail of model
 *    tags beside the grid (FacetRail), a search box that takes tag tokens
 *    (TagSearch), and a detail drawer per card (CatalogueDrawer), after
 *    design/discover-tags.html. The vocabulary is in models/discover.ts.
 *
 * Route: `/models`, inside the `RequireAuth` + `AppShell` block in App.tsx.
 * Which tab is open lives in the query string — `/models?tab=discover` — not in
 * component state and not in localStorage. A reload keeps the tab you were on,
 * the back button steps back through the tabs you opened, and a tab worth
 * returning to can be pasted to somebody else. A bare `/models` is still valid
 * and opens Installed, and so does a `tab` value that means nothing.
 *
 * Discover's filters live there too, beside the tab — `?tab=discover&tag=
 * task:text-to-image&tag=-license:other&sort=likes` — for the same reasons: a
 * filtered view survives a reload and can be sent to somebody. Unlike the tab,
 * a filter change *replaces* the history entry rather than pushing one; Back
 * should leave Discover, not un-type a search one keystroke at a time.
 *
 * Reading the installed list is open to any signed-in user; the catalogue and
 * every install route are admin-only. A non-admin therefore gets a working
 * Installed tab and an explicit "you need to be an admin" panel where the
 * catalogue would be, rather than a 403 that reaches the console.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { setTargetBackend, useTargetBackend } from '../shell/useTargetBackend';
import { FindPartContext, type PartSearch } from '../models/MissingParts';
import type { Model, ModelCatalogEntry, ModelType, Uuid } from '@comfy/shared';
import { useAuth } from '../auth/context';
import { modelsApi, type ModelsApi } from '../lib/api-models';
import { storageApi, type StorageApi } from '../lib/api-storage';
import { StoragePanel } from '../models/StoragePanel';
import { CatalogueGrid, type LoadVariants } from '../models/CatalogueGrid';
import { FilterBar } from '../models/FilterBar';
import { InstalledList } from '../models/InstalledList';
import { backendMemory } from '../models/cardFacts';
import { InstallsList } from '../models/InstallsList';
import { WorkflowSheet, type WorkflowSheetSubject } from '../models/WorkflowSheet';
import { ApiRequestError } from '../lib/api';
import { WorkflowIcon } from '../models/icons';
import { Notice } from '../models/Notice';
import { CubeIcon } from '../models/icons';
import {
  catalogueTypes,
  familyLabel,
  filterCatalogue,
  filterInstalled,
  latestByFilename,
  MODEL_TYPES,
  TYPE_LABELS,
} from '../models/catalogue';
import { INTENTS, INTENT_WORDS, type Intent } from '../models/intents';
import {
  DEFAULT_DISCOVER,
  SORT_LABELS,
  inScope,
  parseSearch,
  readDiscover,
  resolverFor,
  sortCatalogue,
  tagFacets,
  vocabulary,
  writeDiscover,
  type CatalogueSort,
  type DiscoverState,
  type TagKey,
} from '../models/discover';
import { FacetRail } from '../models/FacetRail';
import { TagSearch } from '../models/TagSearch';
import { useCatalogue } from '../models/useCatalogue';
import { useWithLayouts } from '../models/weightsLayouts';

const NO_ENTRIES: ModelCatalogEntry[] = [];
import { HostApproval } from '../models/HostApproval';
import { useInstalls } from '../models/useInstalls';
import { useModelLibrary } from '../models/useModelLibrary';
import { useNow } from '../models/useNow';
import panels from '../models/ModelsPanels.module.css';
import { Mark } from '../components/Mark';
import styles from './ModelsPage.module.css';

type Tab = 'installed' | 'discover' | 'downloads' | 'storage';

const TABS: readonly Tab[] = ['installed', 'discover', 'downloads', 'storage'];

/** The default, and the one spelling that is left out of the URL entirely. */
const DEFAULT_TAB: Tab = 'discover';

/**
 * Installed's type filter, remembered for the session per api. Both tabs open
 * on every type (Discover's lives in the URL); a choice the user makes sticks
 * until they change it.
 */
const lastInstalledType = new WeakMap<ModelsApi, ModelType | null>();

function tabFromParams(params: URLSearchParams): Tab {
  const asked = params.get('tab');
  return TABS.includes(asked as Tab) ? (asked as Tab) : DEFAULT_TAB;
}

export interface ModelsPageProps {
  /** Injected in tests. Production always uses the live client. */
  api?: ModelsApi;
  /** The Storage tab's client, likewise. */
  storageApi?: StorageApi;
}

/** The Models URL last left, per api; see `restoring` in ModelsPage. */
const lastSearch = new WeakMap<ModelsApi, string>();

export function ModelsPage({ api = modelsApi, storageApi: storage = storageApi }: ModelsPageProps = {}) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const library = useModelLibrary(api);

  const [params, setParams] = useSearchParams();

  // Coming back to Models from elsewhere lands on the tab, search and filters
  // left behind, not a fresh page: the sidebar link is a bare /models, so a
  // bare URL with a remembered one is restored. Per api, as the data caches are.
  const restoring = useRef(params.toString() === '' && Boolean(lastSearch.get(api)));
  useEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      setParams(new URLSearchParams(lastSearch.get(api)!), { replace: true });
      return;
    }
    lastSearch.set(api, params.toString());
  }, [api, params, setParams]);

  const tab = tabFromParams(params);
  const setTab = useCallback(
    (next: Tab) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          // Discover is the default, so it is expressed by the absence of the
          // parameter: `/models` and `/models?tab=installed` are the same page,
          // and the plain URL is the one worth having in the address bar.
          if (next === DEFAULT_TAB) updated.delete('tab');
          else updated.set('tab', next);
          return updated;
        },
        // A push, not a replace: switching tab is a navigation the user means,
        // and Back returning to the tab they came from is the whole point.
        { replace: false },
      );
    },
    [setParams],
  );

  // The machine is the one the shell's pill picks: one choice for the whole
  // app. This page used to keep its own, and two pickers that could disagree
  // was more confusing than useful. A ?backend= link still chooses it.
  const [linkedBackend] = useState(() => params.get('backend'));
  useEffect(() => {
    if (linkedBackend) setTargetBackend(linkedBackend);
  }, [linkedBackend]);
  const target = useTargetBackend();
  const backendId: Uuid | null =
    target && library.backends.some((candidate) => candidate.id === target)
      ? target
      : (() => {
          const enabled = library.backends.filter((backend) => backend.enabled);
          return (enabled.find((backend) => backend.status === 'online') ?? enabled[0] ?? library.backends[0])?.id ?? null;
        })();

  const backend = library.backends.find((candidate) => candidate.id === backendId) ?? null;

  const catalogue = useCatalogue({
    api,
    backendId,
    backendName: backend?.name ?? null,
    backendStatus: backend?.status ?? null,
    enabled: isAdmin,
  });

  const installs = useInstalls({ api, backendId, enabled: isAdmin });
  const now = useNow(installs.live.length > 0);

  // ------------------------------------------------------------- workflows

  // The Workflows sheet: one model's options, or the templates browser.
  const [sheet, setSheet] = useState<WorkflowSheetSubject | null>(() => new URLSearchParams(window.location.search).has('workflows') ? {mode:'browse',family:null} : null);
  const closeSheet = useCallback(() => setSheet(null), []);
  const openModelWorkflows = useCallback((model: Model) => setSheet({ mode: 'model', model }), []);
  const openTemplates = useCallback(
    (entry?: ModelCatalogEntry) => setSheet({ mode: 'browse', family: entry?.base ?? null, sourceName: entry?.sourceWorkflow?.name }),
    [],
  );

  // What removing a model left behind — the API's own sentence about the file
  // that is still on the machine. Shown until dismissed, not as a toast.
  const [removalNote, setRemovalNote] = useState<string | null>(null);
  const removeModel = useCallback(
    async (model: Model) => {
      // Optimistic: the row goes now, and comes back on a refresh if the
      // request fails.
      library.remove(model.id);
      try {
        const removal = await api.removeModel(model.id);
        setRemovalNote(
          removal.note ??
            (removal.removedFromDisk
              ? `${model.displayName} was removed, file included.`
              : `${model.displayName} was removed.`),
        );
      } catch (cause) {
        setRemovalNote(
          cause instanceof ApiRequestError
            ? `Could not remove ${model.displayName}: ${cause.message}`
            : `Could not remove ${model.displayName}.`,
        );
        library.refresh();
      }
    },
    [api, library],
  );

  // A finished install has put a file on a machine, so the installed list and
  // the catalogue's `installed` flags are both stale. Refresh once per
  // completion rather than on every poll.
  const settled = useRef<Set<string>>(new Set());
  useEffect(() => {
    let changed = false;
    for (const install of installs.installs) {
      if (install.status === 'complete' && !settled.current.has(install.id)) {
        settled.current.add(install.id);
        changed = true;
      }
    }
    if (changed && settled.current.size > 0) {
      library.refresh();
      catalogue.reload();
    }
    // `library`/`catalogue` identities are stable per render only for their
    // callbacks, which is all this uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installs.installs]);

  // ------------------------------------------------------------- installed

  // Every type by default, as on Discover; a type the user picks is kept for
  // the session.
  const [installedType, setInstalledTypeState] = useState<ModelType | null>(() => lastInstalledType.get(api) ?? null);
  const setInstalledType = useCallback(
    (type: ModelType | null) => {
      lastInstalledType.set(api, type);
      setInstalledTypeState(type);
    },
    [api],
  );
  const [installedFamily, setInstalledFamily] = useState<string | null>(null);
  const [installedQ, setInstalledQ] = useState('');

  // Everything except the type filter — the population every type chip counts
  // against, so a chip states what clicking it would leave.
  const installedBeforeType = useMemo(
    () => filterInstalled(library.models, { type: null, family: installedFamily, q: installedQ }),
    [library.models, installedFamily, installedQ],
  );

  const installedFiltered = useMemo(
    () => installedBeforeType.filter((model) => !installedType || model.type === installedType),
    [installedBeforeType, installedType],
  );

  const installedTypeCounts = useMemo(() => {
    const counts = new Map<ModelType, number>();
    for (const model of installedBeforeType) {
      counts.set(model.type, (counts.get(model.type) ?? 0) + 1);
    }
    return MODEL_TYPES.filter((type) => counts.has(type)).map((type) => ({
      type,
      count: counts.get(type)!,
    }));
  }, [installedBeforeType]);

  const backendOrder = useMemo(
    () =>
      library.backends.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        online: candidate.status === 'online',
      })),
    [library.backends],
  );

  // ------------------------------------------------------------- catalogue

  const discover = useMemo(() => readDiscover(params), [params]);
  const setDiscover = useCallback(
    (update: (current: DiscoverState) => DiscoverState) => {
      setParams((current) => writeDiscover(current, update(readDiscover(current))), {
        replace: true,
      });
    },
    [setParams],
  );

  // "Find" on a missing part: a search for it, with its type chosen, since
  // Discover leaves parts out otherwise. Tags and intent are cleared because a
  // filter for SDXL models would hide the very text encoder being looked for.
  const findPart = useCallback(
    (search: PartSearch) => {
      // One URL write: two setParams in one tick each start from the same
      // URL, so the second would undo the first.
      setParams((current) => {
        const next = writeDiscover(current, {
          ...readDiscover(current),
          q: search.q,
          type: search.type,
          intent: 'all',
          include: [],
          exclude: [],
        });
        next.delete('tab'); // Discover is the default tab.
        return next;
      });
    },
    [setParams],
  );

  // Filters are per backend: "SDXL" may not be a family the next machine's
  // catalogue even has, and a stale tag would silently show nothing. The
  // verdict is per backend too — a model that runs on one machine may be
  // missing its text encoder on the next. Only a *change* of backend resets,
  // though: the first one being chosen on load must not wipe a filter that
  // arrived in the URL.
  const filteredFor = useRef<Uuid | null>(null);
  useEffect(() => {
    if (filteredFor.current && backendId && filteredFor.current !== backendId) {
      setDiscover((current) => ({ ...DEFAULT_DISCOVER, sort: current.sort }));
    }
    filteredFor.current = backendId;
  }, [backendId, setDiscover]);

  const rawEntries = catalogue.state.kind === 'ready' ? catalogue.state.entries : NO_ENTRIES;
  // Layouts read as cards are seen (weightsLayouts.ts): a file ComfyUI can't
  // load sorts last and leaves "Works on this machine".
  const entries = useWithLayouts(rawEntries);
  // The bare words of the search box. Tag-shaped words are not text, whether
  // or not they have been committed yet.
  const catText = useMemo(() => parseSearch(discover.q).text, [discover.q]);

  // Search and tags only: the population every chip and count below is a
  // slice of. Intent, type and Works on this machine are applied on top (see
  // `inScope`) so each can be counted with the others held still.
  const catalogueSearched = useMemo(
    () =>
      filterCatalogue(entries, {
        type: null,
        base: null,
        q: catText,
        run: 'all',
        include: discover.include,
        exclude: discover.exclude,
      }),
    [entries, catText, discover.include, discover.exclude],
  );

  const catalogueFiltered = useMemo(
    () =>
      sortCatalogue(
        catalogueSearched.filter((entry) => inScope(entry, discover)),
        discover.sort,
      ),
    [catalogueSearched, discover, discover.sort],
  );

  // A type row says what clicking it would leave. Choosing a type widens the
  // intent to Everything (see onType below), so its rows are counted that way;
  // parts are counted too, because choosing one is the only way to browse
  // them. "Any type" keeps the intent, so it is counted with it.
  const catalogueTypeCounts = useMemo(
    () => ({
      types: catalogueTypes(
        catalogueSearched.filter((entry) =>
          inScope(entry, { ...discover, intent: 'all', type: entry.type }),
        ),
      ),
      all: catalogueSearched.filter((entry) => inScope(entry, { ...discover, type: null })).length,
    }),
    [catalogueSearched, discover],
  );

  // How many each intent chip would show, everything else held still.
  const intentCounts = useMemo(() => {
    const counts = {} as Record<Intent, number>;
    for (const intent of INTENTS) {
      counts[intent] = catalogueSearched.filter((entry) =>
        inScope(entry, { ...discover, intent }),
      ).length;
    }
    return counts;
  }, [catalogueSearched, discover]);

  // What the empty state needs to offer the right way out: would turning off
  // Works on this machine find anything?
  const hiddenByRuns = useMemo(
    () =>
      discover.runs
        ? catalogueSearched.filter((entry) => inScope(entry, { ...discover, runs: false })).length
        : 0,
    [catalogueSearched, discover],
  );

  const tagVocabulary = useMemo(() => vocabulary(entries), [entries]);
  const tagCounts = useMemo(() => tagFacets(catalogueFiltered), [catalogueFiltered]);
  const resolveTag = useMemo(() => resolverFor(tagVocabulary), [tagVocabulary]);
  const activeTags = useMemo(() => new Set(discover.include), [discover.include]);

  /** A chip, a facet row or a drawer tag: on if it was off, off if it was on. */
  const toggleTag = useCallback(
    (key: TagKey) =>
      setDiscover((current) => ({
        ...current,
        include: current.include.includes(key)
          ? current.include.filter((other) => other !== key)
          : [...current.include, key],
        exclude: current.exclude.filter((other) => other !== key),
      })),
    [setDiscover],
  );

  const clearDiscover = useCallback(
    () => setDiscover((current) => ({ ...DEFAULT_DISCOVER, sort: current.sort })),
    [setDiscover],
  );

  const backendInstalls = useMemo(
    () => installs.installs.filter((install) => install.backendId === backendId),
    [installs.installs, backendId],
  );
  const installsHere = useMemo(() => latestByFilename(backendInstalls), [backendInstalls]);

  const startInstall = installs.start;
  const onInstall = useCallback(
    (entry: ModelCatalogEntry, variant?: string) => {
      if (!backendId) return;
      void startInstall(backendId, entry.ref, variant);
    },
    [backendId, startInstall],
  );
  const loadVariants = useMemo(
    () =>
      backendId && api.variants
        ? (ref: string, signal?: AbortSignal) => api.variants!(backendId, ref, signal)
        : undefined,
    [api, backendId],
  );

  // ------------------------------------------------------------- render

  const liveCount = installs.live.length;

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <h1 className={`display ${styles.title}`}>Models</h1>

        <nav className={styles.tabs} aria-label="Models sections">
          <TabButton id="discover" active={tab} onSelect={setTab} label="Discover" />
          <TabButton
            id="installed"
            active={tab}
            onSelect={setTab}
            label="Installed"
            count={library.models.length}
          />
          <TabButton
            id="downloads"
            active={tab}
            onSelect={setTab}
            label="Downloads"
            count={liveCount || undefined}
            accentCount
          />
          {/* Reading a machine's disk is an operator's view; the tab is not
              offered to anyone else rather than shown and refused. */}
          {isAdmin ? <TabButton id="storage" active={tab} onSelect={setTab} label="Storage" /> : null}
        </nav>

        <div className={styles.spacer} />

      </header>

      <FindPartContext.Provider value={findPart}>
      <div className={styles.body}>
        {library.loading ? (
          <div className={styles.loading} role="status">
            <Mark size={22} ripple="loop" />
            Reading your backends…
          </div>
        ) : library.error ? (
          <Notice
            tone="danger"
            title="Could not load models"
            message={library.error}
            action={{ label: 'Try again', onClick: library.refresh }}
          />
        ) : library.backends.length === 0 ? (
          <Notice
            title="No backends yet"
            message="Models live on a ComfyUI machine, and there are none registered. Add a backend and its models are discovered automatically."
          />
        ) : tab === 'storage' ? (
          <div className={styles.scroller}>
            {!isAdmin ? (
              <AdminOnly />
            ) : backend ? (
              <StoragePanel key={backend.id} api={storage} backend={backend} />
            ) : (
              <Notice title="No backend" message="Register a ComfyUI backend first; its disk shows up here." />
            )}
          </div>
        ) : tab === 'installed' ? (
          <>
            <FilterBar
              q={installedQ}
              onQ={setInstalledQ}
              searchLabel="Search installed models"
              searchPlaceholder="Search installed models"
              types={installedTypeCounts}
              allCount={installedBeforeType.length}
              activeType={installedType}
              onType={setInstalledType}
              familyOptions={library.families.map((family) => ({
                value: family,
                label: familyLabel(family),
              }))}
              familyLabel="Base"
              activeFamily={installedFamily}
              onFamily={setInstalledFamily}
              shown={installedFiltered.length}
              total={library.models.length}
            />
            <div className={styles.scroller}>
              <div className={panels.panelTools}>
                <button
                  type="button"
                  className={panels.rowAction}
                  onClick={() => openTemplates()}
                >
                  <WorkflowIcon size={13} />
                  Browse templates
                </button>
              </div>
              {removalNote ? (
                <p className={`${panels.removalNote} rise`} role="status">
                  <span>{removalNote}</span>
                  <button
                    type="button"
                    className={panels.removalNoteDismiss}
                    onClick={() => setRemovalNote(null)}
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </p>
              ) : null}
              {library.models.length === 0 ? (
                <Notice
                  title="Nothing installed yet"
                  message="No backend is reporting a model file. Once one has a checkpoint on disk it appears here within a poll, or install one from Discover."
                  action={{ label: 'Open Discover', onClick: () => setTab('discover') }}
                />
              ) : installedFiltered.length === 0 ? (
                <Notice
                  title="No models match"
                  message="Nothing installed matches that filter."
                  action={{
                    label: 'Clear filters',
                    onClick: () => {
                      setInstalledQ('');
                      setInstalledType(null);
                      setInstalledFamily(null);
                    },
                  }}
                />
              ) : (
                <InstalledList
                  models={installedFiltered}
                  backendOrder={backendOrder}
                  selectedBackendId={backendId}
                  memoryBytes={backendMemory(backend)}
                  installs={installs.installs}
                  runnability={library.runnability}
                  previews={library.previews}
                  onWorkflows={openModelWorkflows}
                  onFixed={library.refresh}
                  onRemove={isAdmin ? (model) => void removeModel(model) : undefined}
                />
              )}
            </div>
          </>
        ) : tab === 'discover' ? (
          <div className={entries.length > 0 ? panels.discover : panels.discoverBare}>
            {entries.length > 0 ? (
              <FacetRail
                types={catalogueTypeCounts.types}
                allTypesCount={catalogueTypeCounts.all}
                activeType={discover.type}
                // Choosing a type is the expert route: it widens the intent to
                // Everything, or "Image decoders" under "Make images" would
                // always be empty.
                onType={(type) =>
                  setDiscover((current) => ({ ...current, type, intent: type ? 'all' : current.intent }))
                }
                known={tagVocabulary}
                counts={tagCounts}
                include={discover.include}
                onToggle={toggleTag}
              />
            ) : null}

            <div className={styles.scroller}>
              {entries.length > 0 ? (
                <div className={panels.discoverHead}>
                  <div className={panels.intentRow} role="group" aria-label="What do you want to do?">
                    {INTENTS.map((intent) => (
                      <button
                        key={intent}
                        type="button"
                        className={`${panels.intentChip} ${discover.intent === intent ? panels.intentChipOn : ''}`}
                        aria-pressed={discover.intent === intent}
                        title={INTENT_WORDS[intent].explain}
                        // An intent is the plain-language route, so it clears
                        // the expert type filter rather than combining with it.
                        onClick={() => setDiscover((current) => ({ ...current, intent, type: null }))}
                      >
                        {INTENT_WORDS[intent].label}
                        <span className={`mono ${panels.intentCount}`}>{intentCounts[intent]}</span>
                      </button>
                    ))}
                  </div>
                  <p className={panels.intentExplain}>
                    {discover.type
                      ? `Showing ${TYPE_LABELS[discover.type].toLowerCase()} only, from More filters.`
                      : INTENT_WORDS[discover.intent].explain}
                  </p>
                  <TagSearch
                    q={discover.q}
                    onQ={(q) => setDiscover((current) => ({ ...current, q }))}
                    include={discover.include}
                    exclude={discover.exclude}
                    onCommit={(tags, rest) =>
                      setDiscover((current) => ({
                        ...current,
                        q: rest,
                        // A tag moves between the lists rather than sitting in
                        // both: including what was excluded un-excludes it.
                        include: [
                          ...current.include.filter((key) => !tags.exclude.includes(key)),
                          ...tags.include.filter((key) => !current.include.includes(key)),
                        ],
                        exclude: [
                          ...current.exclude.filter((key) => !tags.include.includes(key)),
                          ...tags.exclude.filter((key) => !current.exclude.includes(key)),
                        ],
                      }))
                    }
                    onRemove={(key, negate) =>
                      setDiscover((current) =>
                        negate
                          ? { ...current, exclude: current.exclude.filter((other) => other !== key) }
                          : { ...current, include: current.include.filter((other) => other !== key) },
                      )
                    }
                    known={tagVocabulary}
                    counts={tagCounts}
                    resolve={resolveTag}
                    label="Search the catalogue"
                    placeholder={`Search what ${backend?.name ?? 'this backend'} can install, or type a tag…`}
                  />
                  <p className={panels.searchHint}>
                    Click any tag to filter · <code>tag:</code> <code>task:</code> <code>base:</code>{' '}
                    <code>license:</code> in the box · <code>-tag</code> to exclude
                  </p>
                  <div className={panels.discoverBar}>
                    <span className={panels.discoverCount}>
                      <span className="mono">{catalogueFiltered.length}</span> of{' '}
                      <span className="mono">{entries.length}</span> models
                    </span>
                    <span className={styles.spacer} />
                    <label className={panels.runToggle}>
                      <input
                        type="checkbox"
                        checked={discover.runs}
                        onChange={(event) => {
                          const runs = event.target.checked;
                          setDiscover((current) => ({ ...current, runs }));
                        }}
                      />
                      Works on this machine
                    </label>
                    <div className={panels.sortSeg} role="group" aria-label="Sort by">
                      {(Object.keys(SORT_LABELS) as CatalogueSort[]).map((sort) => (
                        <button
                          key={sort}
                          type="button"
                          className={discover.sort === sort ? panels.sortOn : undefined}
                          aria-pressed={discover.sort === sort}
                          onClick={() => setDiscover((current) => ({ ...current, sort }))}
                        >
                          {SORT_LABELS[sort]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              <CatalogueBody
                state={catalogue.state}
                filtered={catalogueFiltered}
                installsHere={installsHere}
                starting={installs.starting}
                canInstall={backend?.status === 'online'}
                onInstall={onInstall}
                loadVariants={loadVariants}
                failure={installs.startFailure}
                now={now}
                onReload={catalogue.reload}
                onWorkflows={openTemplates}
                onClearFilters={clearDiscover}
                hiddenByRuns={hiddenByRuns}
                onShowEverything={() => setDiscover((current) => ({ ...current, runs: false }))}
                intentLabel={discover.type ? null : INTENT_WORDS[discover.intent].label}
                onTag={toggleTag}
                activeTags={activeTags}
                backendName={backend?.name ?? null}
                memoryBytes={backendMemory(backend)}
              />
            </div>
          </div>
        ) : (
          <div className={styles.scroller}>
            {!isAdmin ? (
              <AdminOnly />
            ) : installs.loading ? (
              <div className={styles.loading} role="status">
            <Mark size={22} ripple="loop" />
                Checking for downloads…
              </div>
            ) : installs.error ? (
              <Notice tone="danger" title="Could not read the install queue" message={installs.error} />
            ) : backendInstalls.length === 0 ? (
              <Notice
                title="No downloads"
                message={`Nothing has been installed onto ${
                  backend?.name ?? 'this backend'
                } from here. Installs started elsewhere show up here too, as soon as they are running.`}
                action={{ label: 'Open Discover', onClick: () => setTab('discover') }}
              />
            ) : (
              <InstallsList
                installs={backendInstalls}
                backendName={library.backendName}
                showBackend={false}
                now={now}
              />
            )}
          </div>
        )}
      </div>
      </FindPartContext.Provider>

      {isAdmin ? <HostApproval installs={installs.live} api={api} /> : null}
      {sheet ? (
        <WorkflowSheet
          api={api}
          subject={sheet}
          backendId={backendId}
          isAdmin={isAdmin}
          onClose={closeSheet}
          onAssigned={library.refresh}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function TabButton({
  id,
  active,
  onSelect,
  label,
  count,
  accentCount = false,
}: {
  id: Tab;
  active: Tab;
  onSelect: (tab: Tab) => void;
  label: string;
  count?: number;
  accentCount?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.tab} ${active === id ? styles.tabOn : ''}`}
      aria-current={active === id ? 'page' : undefined}
      onClick={() => onSelect(id)}
    >
      {label}
      {count === undefined ? null : (
        <span className={`mono ${styles.tabCount} ${accentCount ? styles.tabCountAccent : ''}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function AdminOnly() {
  return (
    <Notice
      tone="warning"
      title="You need to be an administrator"
      message="Installing models writes multi-gigabyte files onto a machine everyone shares, so it is an operator action. Ask an administrator to install what you need — everything already installed is listed under Installed."
    />
  );
}

function CatalogueBody({
  state,
  filtered,
  installsHere,
  starting,
  canInstall,
  onInstall,
  loadVariants,
  failure,
  now,
  onReload,
  onWorkflows,
  onClearFilters,
  onTag,
  activeTags,
  backendName,
  memoryBytes,
  hiddenByRuns,
  onShowEverything,
  intentLabel,
}: {
  state: ReturnType<typeof useCatalogue>['state'];
  filtered: ModelCatalogEntry[];
  installsHere: Map<string, import('@comfy/shared').ModelInstall>;
  starting: ReadonlySet<string>;
  canInstall: boolean;
  onInstall: (entry: ModelCatalogEntry, variant?: string) => void;
  loadVariants?: LoadVariants;
  failure: { ref: string; message: string } | null;
  now: number;
  onReload: () => void;
  onWorkflows: (entry: ModelCatalogEntry) => void;
  onClearFilters: () => void;
  onTag: (key: TagKey) => void;
  activeTags: ReadonlySet<TagKey>;
  backendName: string | null;
  memoryBytes?: number | null;
  /** How many results Works on this machine is hiding right now. */
  hiddenByRuns: number;
  onShowEverything: () => void;
  intentLabel: string | null;
}) {
  switch (state.kind) {
    case 'idle':
      return <Notice title="No backend selected" message="Pick a backend to see what it can install." />;

    case 'loading':
      return (
        <div className={panels.grid} aria-hidden>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className={panels.skeleton} />
          ))}
        </div>
      );

    case 'forbidden':
      return <AdminOnly />;

    case 'offline':
      return <Notice tone="warning" title="Backend is offline" message={state.message} />;

    case 'unsupported':
      return (
        <Notice
          tone="warning"
          title="Model installation unavailable"
          message="This machine’s model installer isn’t ready."
          footnote="You can still use models that are already installed."
          action={{ label: 'Try again', onClick: onReload }}
        />
      );

    case 'error':
      return (
        <Notice
          tone="danger"
          title="Could not read the catalogue"
          message={state.message}
          action={{ label: 'Try again', onClick: onReload }}
        />
      );

    case 'ready':
      if (state.entries.length === 0) {
        return (
          <Notice
            title="This backend offers nothing to install"
            message="Its install transport answered, but its catalogue is empty. ComfyUI-Manager builds that list from its own model list, so a Manager that has never fetched one has nothing to offer yet."
            action={{ label: 'Check again', onClick: onReload }}
          />
        );
      }
      if (filtered.length === 0 && hiddenByRuns > 0) {
        // Not "nothing matches": there are matches, they just are not known
        // to run here. Say so, and make the way out one click.
        const machine = backendName ?? 'this machine';
        return (
          <Notice
            title={`Nothing here runs on ${machine} yet`}
            message={
              <>
                <span className="mono">{hiddenByRuns}</span>{' '}
                {hiddenByRuns === 1 ? 'match' : 'matches'}
                {intentLabel ? ` under “${intentLabel}”` : ''} {hiddenByRuns === 1 ? 'is' : 'are'} hidden because {machine} cannot run{' '}
                {hiddenByRuns === 1 ? 'it' : 'them'} yet, or could not be asked. They may still be worth
                a look.
              </>
            }
            action={{ label: 'Show everything', onClick: onShowEverything }}
          />
        );
      }
      if (filtered.length === 0) {
        return (
          <Notice
            title="Nothing matches"
            message={
              <>
                None of the <span className="mono">{state.entries.length}</span> entries this
                backend offers match that filter.
              </>
            }
            action={{ label: 'Clear filters', onClick: onClearFilters }}
          />
        );
      }
      return (
        <>
          {!canInstall ? (
            <p className={styles.offlineHint}>
              <CubeIcon size={14} /> This backend is offline — its catalogue is the last one it
              gave us, and installs cannot start until it is back.
            </p>
          ) : null}
          <CatalogueGrid
            entries={filtered}
            installByFile={installsHere}
            starting={starting}
            canInstall={canInstall}
            onInstall={onInstall}
            loadVariants={loadVariants}
            failure={failure}
            now={now}
            onWorkflows={onWorkflows}
            onTag={onTag}
            activeTags={activeTags}
            backendName={backendName}
            memoryBytes={memoryBytes}
          />
        </>
      );
  }
}
