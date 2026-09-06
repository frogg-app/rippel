/**
 * The Models screen (PLAN.md §4 phase 6).
 *
 * Layout from `design/parts/ModelBrowser.body.html`: a 60px band with the serif
 * title, a tab strip carrying live counts, and a status pill on the right; then
 * a search-and-chips band; then the content. Three deviations from the artboard,
 * each forced by what the API can actually say, each noted where it happens:
 *
 *  - The artboard's source toggle is "Civitai / Hugging Face". The real install
 *    path is whitelisted per backend — a `ref` the backend's catalogue does not
 *    offer is refused — so the toggle is a **backend** picker instead. What you
 *    can install is a property of the machine you are installing onto, and a UI
 *    that offered a registry to search would be promising something the
 *    transport will not do.
 *  - The artboard's cards are photographs with a percentage bar. There is now a
 *    photograph on about half of them — the API resolves each entry's model page
 *    and serves a cached sample image — but never a percentage: the transport
 *    reports tasks, not bytes. See CatalogueCard and InstallProgress.
 *  - 42 base families is a select, not a chip row. See FilterBar.
 *
 * Route: `/models`, inside the `RequireAuth` + `AppShell` block in App.tsx.
 * Which tab is open lives in the query string — `/models?tab=discover` — not in
 * component state and not in localStorage. A reload keeps the tab you were on,
 * the back button steps back through the tabs you opened, and a tab worth
 * returning to can be pasted to somebody else. A bare `/models` is still valid
 * and opens Installed, and so does a `tab` value that means nothing.
 *
 * Reading the installed list is open to any signed-in user; the catalogue and
 * every install route are admin-only. A non-admin therefore gets a working
 * Installed tab and an explicit "you need to be an admin" panel where the
 * catalogue would be, rather than a 403 that reaches the console.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ModelCatalogEntry, ModelType, Uuid } from '@comfy/shared';
import { useAuth } from '../auth/context';
import { modelsApi, type ModelsApi } from '../lib/api-models';
import { CatalogueGrid } from '../models/CatalogueGrid';
import { FilterBar } from '../models/FilterBar';
import { InstalledList } from '../models/InstalledList';
import { InstallsList } from '../models/InstallsList';
import { Notice } from '../models/Notice';
import { CubeIcon } from '../models/icons';
import {
  catalogueBases,
  catalogueTypes,
  familyLabel,
  filterCatalogue,
  filterInstalled,
  latestByFilename,
  matchesRunFilter,
  MODEL_TYPES,
  type RunFilter,
} from '../models/catalogue';
import { useCatalogue } from '../models/useCatalogue';
import { useInstalls } from '../models/useInstalls';
import { useModelLibrary } from '../models/useModelLibrary';
import { useNow } from '../models/useNow';
import panels from '../models/ModelsPanels.module.css';
import styles from './ModelsPage.module.css';

type Tab = 'installed' | 'discover' | 'downloads';

const TABS: readonly Tab[] = ['installed', 'discover', 'downloads'];

/** The default, and the one spelling that is left out of the URL entirely. */
const DEFAULT_TAB: Tab = 'installed';

function tabFromParams(params: URLSearchParams): Tab {
  const asked = params.get('tab');
  return TABS.includes(asked as Tab) ? (asked as Tab) : DEFAULT_TAB;
}

export interface ModelsPageProps {
  /** Injected in tests. Production always uses the live client. */
  api?: ModelsApi;
}

export function ModelsPage({ api = modelsApi }: ModelsPageProps = {}) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const library = useModelLibrary(api);

  const [params, setParams] = useSearchParams();
  const tab = tabFromParams(params);
  const setTab = useCallback(
    (next: Tab) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          // Installed is the default, so it is expressed by the absence of the
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

  const [backendId, setBackendId] = useState<Uuid | null>(null);

  // Default to the backend the shell's pill would show: an online one first,
  // because that is the one an install can actually run on.
  useEffect(() => {
    if (backendId || library.backends.length === 0) return;
    const enabled = library.backends.filter((backend) => backend.enabled);
    const preferred =
      enabled.find((backend) => backend.status === 'online') ?? enabled[0] ?? library.backends[0];
    setBackendId(preferred?.id ?? null);
  }, [backendId, library.backends]);

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

  const [installedType, setInstalledType] = useState<ModelType | null>(null);
  const [installedFamily, setInstalledFamily] = useState<string | null>(null);
  const [installedQ, setInstalledQ] = useState('');

  const installedFiltered = useMemo(
    () =>
      filterInstalled(library.models, {
        type: installedType,
        family: installedFamily,
        q: installedQ,
      }),
    [library.models, installedType, installedFamily, installedQ],
  );

  const installedTypeCounts = useMemo(() => {
    const counts = new Map<ModelType, number>();
    for (const model of library.models) counts.set(model.type, (counts.get(model.type) ?? 0) + 1);
    return MODEL_TYPES.filter((type) => counts.has(type)).map((type) => ({
      type,
      count: counts.get(type)!,
    }));
  }, [library.models]);

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

  const [catType, setCatType] = useState<ModelType | null>(null);
  const [catBase, setCatBase] = useState<string | null>(null);
  const [catQ, setCatQ] = useState('');
  const [catRun, setCatRun] = useState<RunFilter>('all');

  // Filters are per backend: "SDXL" may not be a family the next machine's
  // catalogue even has, and a stale chip would silently show nothing.
  useEffect(() => {
    setCatType(null);
    setCatBase(null);
    setCatQ('');
    // The verdict is per backend too — a model that runs on one machine may be
    // missing its text encoder on the next — so this resets with the rest.
    setCatRun('all');
  }, [backendId]);

  const entries = catalogue.state.kind === 'ready' ? catalogue.state.entries : [];
  const catalogueFiltered = useMemo(
    () => filterCatalogue(entries, { type: catType, base: catBase, q: catQ, run: catRun }),
    [entries, catType, catBase, catQ, catRun],
  );

  // Counts for the runnability segments, taken *under the other filters* and
  // not under this one: a segment has to say how many rows it would leave, and
  // a count that changed when you pressed it would be describing the answer
  // rather than the choice.
  const runCounts = useMemo(() => {
    const rest = filterCatalogue(entries, { type: catType, base: catBase, q: catQ, run: 'all' });
    return {
      all: rest.length,
      runs: rest.filter((entry) => matchesRunFilter(entry.runnability, 'runs')).length,
      blocked: rest.filter((entry) => matchesRunFilter(entry.runnability, 'blocked')).length,
    };
  }, [entries, catType, catBase, catQ]);

  const backendInstalls = useMemo(
    () => installs.installs.filter((install) => install.backendId === backendId),
    [installs.installs, backendId],
  );
  const installsHere = useMemo(() => latestByFilename(backendInstalls), [backendInstalls]);

  const startInstall = installs.start;
  const onInstall = useCallback(
    (entry: ModelCatalogEntry) => {
      if (!backendId) return;
      void startInstall(backendId, entry.ref);
    },
    [backendId, startInstall],
  );

  // ------------------------------------------------------------- render

  const liveCount = installs.live.length;

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <h1 className={`serif ${styles.title}`}>Models</h1>

        <nav className={styles.tabs} aria-label="Models sections">
          <TabButton
            id="installed"
            active={tab}
            onSelect={setTab}
            label="Installed"
            count={library.models.length}
          />
          <TabButton id="discover" active={tab} onSelect={setTab} label="Discover" />
          <TabButton
            id="downloads"
            active={tab}
            onSelect={setTab}
            label="Downloads"
            count={liveCount || undefined}
            accentCount
          />
        </nav>

        <div className={styles.spacer} />

        {library.backends.length > 0 ? (
          <div className={styles.backendPicker}>
            <span
              className={`${styles.dot} ${backend?.status === 'online' ? styles.dotOn : ''}`}
              aria-hidden
            />
            <label className={styles.backendLabel} htmlFor="models-backend">
              {tab === 'installed' ? 'Highlighting' : 'Installing to'}
            </label>
            <select
              id="models-backend"
              className={styles.backendSelect}
              value={backendId ?? ''}
              onChange={(event) => setBackendId(event.target.value || null)}
            >
              {library.backends.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.status === 'online' ? '' : ' (offline)'}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      <div className={styles.body}>
        {library.loading ? (
          <div className={styles.loading} role="status">
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
        ) : tab === 'installed' ? (
          <>
            <FilterBar
              q={installedQ}
              onQ={setInstalledQ}
              searchLabel="Search installed models"
              searchPlaceholder="Search installed models"
              types={installedTypeCounts}
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
                  runnability={library.runnability}
                />
              )}
            </div>
          </>
        ) : tab === 'discover' ? (
          <>
            {catalogue.state.kind === 'ready' && catalogue.state.entries.length > 0 ? (
              <FilterBar
                q={catQ}
                onQ={setCatQ}
                searchLabel="Search the catalogue"
                searchPlaceholder={`Search what ${backend?.name ?? 'this backend'} can install`}
                types={catalogueTypes(catalogue.state.entries)}
                activeType={catType}
                onType={setCatType}
                familyOptions={catalogueBases(catalogue.state.entries).map((base) => ({
                  value: base,
                  label: base,
                }))}
                familyLabel="Base"
                activeFamily={catBase}
                onFamily={setCatBase}
                shown={catalogueFiltered.length}
                total={catalogue.state.entries.length}
                run={catRun}
                onRun={setCatRun}
                runCounts={runCounts}
              />
            ) : null}

            <div className={styles.scroller}>
              <CatalogueBody
                state={catalogue.state}
                filtered={catalogueFiltered}
                installsHere={installsHere}
                starting={installs.starting}
                canInstall={backend?.status === 'online'}
                onInstall={onInstall}
                failure={installs.startFailure}
                now={now}
                onReload={catalogue.reload}
                onClearFilters={() => {
                  setCatQ('');
                  setCatType(null);
                  setCatBase(null);
                  setCatRun('all');
                }}
              />
            </div>
          </>
        ) : (
          <div className={styles.scroller}>
            {!isAdmin ? (
              <AdminOnly />
            ) : installs.loading ? (
              <div className={styles.loading} role="status">
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
  failure,
  now,
  onReload,
  onClearFilters,
}: {
  state: ReturnType<typeof useCatalogue>['state'];
  filtered: ModelCatalogEntry[];
  installsHere: Map<string, import('@comfy/shared').ModelInstall>;
  starting: ReadonlySet<string>;
  canInstall: boolean;
  onInstall: (entry: ModelCatalogEntry) => void;
  failure: { ref: string; message: string } | null;
  now: number;
  onReload: () => void;
  onClearFilters: () => void;
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
      // The 501 message names the fix, so it is rendered exactly as the API
      // wrote it. This is the state a stock ComfyUI is in, which is most of
      // them, and it is the difference between "nothing here" and "here is
      // what to install to make this work".
      return (
        <Notice
          tone="warning"
          title="This backend cannot install models"
          message={state.message}
          footnote="Models already on its disk are still listed under Installed."
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
            failure={failure}
            now={now}
          />
        </>
      );
  }
}
