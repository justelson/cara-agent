import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenText,
  Check,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  Image as ImageIcon,
  LockKeyhole,
  Moon,
  Move,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { MantineProvider } from "@mantine/core";
import { seedPages } from "./seedPages.js";
import {
  clonePages,
  createDraftPage,
  loadNotebook,
  loadTheme,
  removePageById,
  saveNotebook,
  saveTheme,
  updatePageById,
} from "./lib/notebookState.js";
import {
  loadStoryProcess,
  loadStoryNotebook,
  resetStoryNotebook,
  saveStoryNotebook,
  searchCoverPhotos,
  trackCoverDownload,
} from "./lib/storyApi.js";

const EditorPane = memo(function EditorPane({ page, theme, onChange }) {
  const editor = useCreateBlockNote(
    {
      initialContent: page.blocks,
    },
    [page.id],
  );

  return (
    <BlockNoteView
      editor={editor}
      theme={theme}
      sideMenu={false}
      onChange={() => onChange(page.id, editor.document)}
    />
  );
});

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function coverObjectPosition(cover) {
  const x = Number.isFinite(Number(cover?.position?.x)) ? Number(cover.position.x) : 50;
  const y = Number.isFinite(Number(cover?.position?.y)) ? Number(cover.position.y) : 50;
  return `${x}% ${y}%`;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 50;
  return Math.min(100, Math.max(0, number));
}

function suggestedCoverQuery(page) {
  return page?.cover?.query || `${page?.title || "quiet writing room"} editorial landscape`;
}

function CoverPickerModal({
  query,
  results,
  selected,
  status,
  source,
  onQueryChange,
  onSearch,
  onSelect,
  onApply,
  onClose,
}) {
  return (
    <div className="modal-layer" role="presentation">
      <section className="cover-modal" role="dialog" aria-modal="true" aria-labelledby="cover-picker-title">
        <header className="modal-header">
          <div>
            <div className="settings-eyebrow">
              <ImageIcon size={15} strokeWidth={1.8} />
              Unsplash
            </div>
            <h2 id="cover-picker-title">Change Cover</h2>
          </div>
          <button className="icon-button" aria-label="Close cover picker" onClick={onClose}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </header>

        <form className="cover-search" onSubmit={onSearch}>
          <label className="search-box">
            <Search size={16} strokeWidth={1.8} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search Unsplash"
            />
          </label>
          <button className="ghost-button strong" type="submit">Search</button>
        </form>

        <div className="cover-results" aria-busy={status === "loading"}>
          {status === "loading" && <div className="modal-empty">Searching...</div>}
          {status !== "loading" && results.length === 0 && (
            <div className="modal-empty">No covers found.</div>
          )}
          {results.map((cover) => (
            <button
              className={cx("cover-result", selected?.id === cover.id && "selected")}
              key={`${cover.provider}-${cover.id}`}
              type="button"
              onClick={() => onSelect(cover)}
            >
              <img src={cover.thumbUrl || cover.url} alt={cover.alt} decoding="async" loading="lazy" />
              <span>
                <strong>{cover.alt || "Unsplash image"}</strong>
                <em>{cover.creditName}</em>
              </span>
            </button>
          ))}
        </div>

        <footer className="modal-footer">
          <span>{source === "unsplash" ? "Live Unsplash results" : "Saved cover fallback"}</span>
          <div>
            <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
            <button className="ghost-button strong" type="button" disabled={!selected} onClick={onApply}>
              Apply
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function CoverRepositionModal({ cover, onChange, onSave, onCancel }) {
  const position = cover?.position ?? { x: 50, y: 50 };

  function patchPosition(patch) {
    onChange({
      ...cover,
      position: {
        x: clampPercent(patch.x ?? position.x),
        y: clampPercent(patch.y ?? position.y),
      },
    });
  }

  return (
    <div className="modal-layer" role="presentation">
      <section className="cover-modal reposition-modal" role="dialog" aria-modal="true" aria-labelledby="cover-position-title">
        <header className="modal-header">
          <div>
            <div className="settings-eyebrow">
              <Move size={15} strokeWidth={1.8} />
              Live preview
            </div>
            <h2 id="cover-position-title">Reposition Cover</h2>
          </div>
          <button className="icon-button" aria-label="Cancel reposition" onClick={onCancel}>
            <X size={16} strokeWidth={1.8} />
          </button>
        </header>

        <div className="position-preview">
          <img src={cover.url} alt={cover.alt} style={{ objectPosition: coverObjectPosition(cover) }} />
        </div>

        <div className="position-controls">
          <label>
            <span>Horizontal</span>
            <input
              aria-label="Horizontal position"
              type="range"
              min="0"
              max="100"
              value={position.x}
              onChange={(event) => patchPosition({ x: event.target.value })}
            />
          </label>
          <label>
            <span>Vertical</span>
            <input
              aria-label="Vertical position"
              type="range"
              min="0"
              max="100"
              value={position.y}
              onChange={(event) => patchPosition({ y: event.target.value })}
            />
          </label>
        </div>

        <footer className="modal-footer">
          <span>{cover.creditName ? `Photo by ${cover.creditName}` : "Cover image"}</span>
          <div>
            <button className="ghost-button" type="button" onClick={onCancel}>Cancel</button>
            <button className="ghost-button strong" type="button" onClick={onSave}>
              <Check size={15} strokeWidth={1.8} />
              Save
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function SettingsPage({ processSide, storySource }) {
  const status = processSide?.status ?? [];
  const chapters = processSide?.chapters ?? [];
  const keptOut = processSide?.kept_out_of_story_pages ?? [];
  const sourceLabel =
    storySource === "story-db"
      ? "Story DB"
      : storySource === "connecting"
        ? "Connecting"
        : "Local fallback";

  return (
    <div className="settings-scroll">
      <div className="settings-frame">
        <header className="settings-heading">
          <div className="settings-eyebrow">
            <LockKeyhole size={15} strokeWidth={1.8} />
            Machine lane
          </div>
          <h1>Settings</h1>
          <p>Technical process details stay here, outside the story pages.</p>
        </header>

        <section className="settings-section">
          <div className="settings-section-title">
            <Database size={16} strokeWidth={1.8} />
            <h2>Storage</h2>
          </div>
          <div className="settings-row">
            <span>Reader pages</span>
            <strong>Story prose only</strong>
          </div>
          <div className="settings-row">
            <span>Current source</span>
            <strong>{sourceLabel}</strong>
          </div>
          <div className="settings-row">
            <span>Process payload</span>
            <strong>{processSide?.title ?? "Process"}</strong>
          </div>
        </section>

        {status.length > 0 && (
          <section className="settings-section">
            <div className="settings-section-title">
              <LockKeyhole size={16} strokeWidth={1.8} />
              <h2>Process Status</h2>
            </div>
            <div className="settings-status-list">
              {status.map((item) => (
                <div className="settings-note" key={item.label}>
                  <span>{item.label}</span>
                  <p>{item.body}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {chapters.length > 0 && (
          <section className="settings-section">
            <div className="settings-section-title">
              <FileText size={16} strokeWidth={1.8} />
              <h2>Chapter Map</h2>
            </div>
            <div className="settings-chapters">
              {chapters.map((chapter) => (
                <div className="settings-chapter" key={chapter.id}>
                  <strong>{chapter.title}</strong>
                  <span>{chapter.role}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {keptOut.length > 0 && (
          <section className="settings-section">
            <div className="settings-section-title">
              <LockKeyhole size={16} strokeWidth={1.8} />
              <h2>Kept Out</h2>
            </div>
            <ul className="settings-kept-out">
              {keptOut.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [pages, setPages] = useState(() => loadNotebook(seedPages));
  const [activeId, setActiveId] = useState(seedPages[0].id);
  const [activeView, setActiveView] = useState("page");
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [processSide, setProcessSide] = useState(null);
  const [theme, setTheme] = useState(() => loadTheme());
  const [storySource, setStorySource] = useState("connecting");
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverQuery, setCoverQuery] = useState("");
  const [coverResults, setCoverResults] = useState([]);
  const [coverSource, setCoverSource] = useState("unsplash");
  const [coverSearchStatus, setCoverSearchStatus] = useState("idle");
  const [selectedCover, setSelectedCover] = useState(null);
  const [repositionCover, setRepositionCover] = useState(null);
  const [loadedCoverUrls, setLoadedCoverUrls] = useState(() => new Set());
  const [renderedCoverKeys, setRenderedCoverKeys] = useState(() => new Set());
  const titleRef = useRef(null);
  const storySaveReadyRef = useRef(false);
  const loadedCoverUrlsRef = useRef(new Set());
  const pendingCoverLoadsRef = useRef(new Set());
  const lastBlockSnapshotRef = useRef(new Map());

  const activePage = pages.find((page) => page.id === activeId) ?? pages[0];
  const isSettingsActive = activeView === "settings";
  const canDelete = !isSettingsActive && pages.length > 1 && activePage.section !== "Notebook";
  const storageLabel =
    storySource === "story-db"
      ? "Story DB"
      : storySource === "connecting"
        ? "Connecting"
        : "Local fallback";
  const topbarLabel = isSettingsActive
    ? `Technical details - ${storageLabel}`
    : `${activePage.updated} - ${storageLabel}`;
  const activeCoverUrl = activePage.cover?.url || "";
  const activeCoverKey = activePage.cover
    ? `${activePage.id}:${activePage.cover.id || activeCoverUrl}`
    : `${activePage.id}:no-cover`;
  const activeCoverPreloaded = !activeCoverUrl || loadedCoverUrls.has(activeCoverUrl);
  const activeCoverLoaded = !activeCoverUrl || renderedCoverKeys.has(activeCoverKey);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    loadStoryProcess().then((result) => {
      if (!cancelled) setProcessSide(result);
    });

    loadStoryNotebook(seedPages).then((result) => {
      if (cancelled) return;
      setPages(result.pages);
      result.pages.forEach((page) => {
        lastBlockSnapshotRef.current.set(page.id, JSON.stringify(page.blocks));
      });
      setActiveId((current) => (
        result.pages.some((page) => page.id === current)
          ? current
          : result.pages[0]?.id ?? seedPages[0].id
      ));
      setStorySource(result.source);
      storySaveReadyRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const saveTimer = globalThis.setTimeout(() => {
      saveNotebook(pages);
      if (!storySaveReadyRef.current) return;

      saveStoryNotebook(pages).then((ok) => {
        setStorySource(ok ? "story-db" : "local");
      });
    }, 250);

    return () => globalThis.clearTimeout(saveTimer);
  }, [pages]);

  useEffect(() => {
    pages.forEach((page) => preloadCover(page.cover));
  }, [pages]);

  useEffect(() => {
    preloadCover(activePage.cover);
  }, [activePage.id, activePage.cover?.url]);

  useEffect(() => {
    if (!titleRef.current) return;
    titleRef.current.style.height = "auto";
    titleRef.current.style.height = `${titleRef.current.scrollHeight}px`;
  }, [activePage.id, activePage.title]);

  useEffect(() => {
    if (!coverPickerOpen) return;

    const query = suggestedCoverQuery(activePage);
    setCoverQuery(query);
    setSelectedCover(null);
    void runCoverSearch(query);
  }, [coverPickerOpen, activePage.id]);

  const sections = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = normalized
      ? pages.filter((page) =>
          [page.title, page.section, page.description].some((value) =>
            value.toLowerCase().includes(normalized),
          ),
        )
      : pages;

    return filtered.reduce((acc, page) => {
      acc[page.section] ??= [];
      acc[page.section].push(page);
      return acc;
    }, {});
  }, [pages, query]);

  const updatePageBlocks = useCallback((pageId, blocks) => {
    const snapshot = JSON.stringify(blocks);
    if (lastBlockSnapshotRef.current.get(pageId) === snapshot) return;
    lastBlockSnapshotRef.current.set(pageId, snapshot);
    setPages((current) =>
      updatePageById(current, pageId, { blocks }),
    );
  }, []);

  function updateActivePage(patch) {
    setPages((current) => updatePageById(current, activePage.id, patch));
  }

  function markCoverReady(url) {
    if (!url) return;
    pendingCoverLoadsRef.current.delete(url);
    if (loadedCoverUrlsRef.current.has(url)) return;
    loadedCoverUrlsRef.current.add(url);
    setLoadedCoverUrls(new Set(loadedCoverUrlsRef.current));
  }

  function markRenderedCoverReady(url, coverKey) {
    markCoverReady(url);
    setRenderedCoverKeys((current) => {
      if (current.has(coverKey)) return current;
      const next = new Set(current);
      next.add(coverKey);
      return next;
    });
  }

  function settleRenderedCover(event, url, coverKey) {
    const image = event.currentTarget;
    if (!image.decode) {
      markRenderedCoverReady(url, coverKey);
      return;
    }

    image.decode().then(
      () => markRenderedCoverReady(url, coverKey),
      () => markRenderedCoverReady(url, coverKey),
    );
  }

  function preloadCover(cover) {
    const url = cover?.url;
    if (
      !url ||
      loadedCoverUrlsRef.current.has(url) ||
      pendingCoverLoadsRef.current.has(url)
    ) {
      return;
    }

    pendingCoverLoadsRef.current.add(url);
    const image = new Image();
    image.onload = () => markCoverReady(url);
    image.onerror = () => markCoverReady(url);
    image.decoding = "async";
    image.src = url;
    if (image.decode) {
      image.decode().then(
        () => markCoverReady(url),
        () => markCoverReady(url),
      );
    }
  }

  async function runCoverSearch(query) {
    const safeQuery = query.trim() || suggestedCoverQuery(activePage);
    setCoverSearchStatus("loading");
    try {
      const result = await searchCoverPhotos(safeQuery);
      setCoverResults(result.covers);
      setCoverSource(result.source);
      setCoverSearchStatus("ready");
    } catch {
      setCoverResults([]);
      setCoverSource("error");
      setCoverSearchStatus("error");
    }
  }

  function submitCoverSearch(event) {
    event.preventDefault();
    void runCoverSearch(coverQuery);
  }

  function applySelectedCover() {
    if (!selectedCover) return;
    setCoverPickerOpen(false);
    setRepositionCover({
      ...selectedCover,
      position: selectedCover.position ?? { x: 50, y: 50 },
    });
  }

  function openCurrentCoverReposition() {
    if (!activePage.cover) {
      setCoverPickerOpen(true);
      return;
    }
    setRepositionCover(clonePages([activePage.cover])[0]);
  }

  function saveCoverPosition() {
    if (!repositionCover) return;
    const nextCover = {
      ...repositionCover,
      position: {
        x: clampPercent(repositionCover.position?.x),
        y: clampPercent(repositionCover.position?.y),
      },
    };
    updateActivePage({ cover: nextCover });
    setRepositionCover(null);
    void trackCoverDownload(nextCover);
  }

  function addDraft() {
    const next = createDraftPage();
    lastBlockSnapshotRef.current.set(next.id, JSON.stringify(next.blocks));
    setPages((current) => [...current, next]);
    setActiveId(next.id);
    setActiveView("page");
  }

  function deleteActivePage() {
    if (!canDelete) return;
    const remaining = removePageById(pages, activePage.id);
    setPages(remaining);
    setActiveId(remaining[0]?.id ?? seedPages[0].id);
  }

  async function resetNotebook() {
    const result = await resetStoryNotebook(seedPages);
    const fresh = clonePages(result.pages);
    setPages(fresh);
    lastBlockSnapshotRef.current = new Map(fresh.map((page) => [page.id, JSON.stringify(page.blocks)]));
    setActiveId(fresh[0].id);
    setActiveView("page");
    setStorySource(result.source);
    storySaveReadyRef.current = true;
  }

  return (
    <MantineProvider forceColorScheme={theme}>
      <div
        className={cx(
          "app-shell",
          !sidebarOpen && "sidebar-closed",
        )}
        data-theme={theme}
      >
        <aside className={cx("sidebar", !sidebarOpen && "collapsed")}>
          <div className="workspace-row">
            <div className="workspace-mark">
              <BookOpenText size={17} strokeWidth={1.8} />
            </div>
            <div>
              <div className="workspace-title">Cara Notes</div>
              <div className="workspace-subtitle">Private notebook</div>
            </div>
            <button
              className="icon-button"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? (
                <Sun size={17} strokeWidth={1.8} />
              ) : (
                <Moon size={17} strokeWidth={1.8} />
              )}
            </button>
          </div>

          <label className="search-box">
            <Search size={16} strokeWidth={1.8} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
            />
          </label>

          <nav className="page-nav">
            {Object.entries(sections).map(([section, sectionPages]) => (
              <div className="nav-section" key={section}>
                <div className="nav-label">{section}</div>
                {sectionPages.map((page) => (
                  <button
                    key={page.id}
                    className={cx("page-link", !isSettingsActive && page.id === activeId && "active")}
                    onFocus={() => preloadCover(page.cover)}
                    onMouseEnter={() => preloadCover(page.cover)}
                    onClick={() => {
                      setActiveId(page.id);
                      setActiveView("page");
                    }}
                  >
                    <FileText size={16} strokeWidth={1.7} />
                    <span>{page.title.trim() || "Untitled"}</span>
                    <ChevronRight size={14} strokeWidth={1.8} />
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="sidebar-bottom">
            <div className="sidebar-actions">
              <button className="new-page-button" onClick={addDraft}>
                <Plus size={16} strokeWidth={1.9} />
                New page
              </button>
              <button
                className={cx("icon-button", "settings-button", isSettingsActive && "active")}
                aria-label="Open settings"
                title="Settings"
                onClick={() => setActiveView("settings")}
              >
                <Settings size={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </aside>

        <main className="document-area">
          <header className="topbar">
            <button
              className="ghost-button"
              aria-label={sidebarOpen ? "Hide notebook" : "Show notebook"}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((value) => !value)}
            >
              <PanelLeft size={16} strokeWidth={1.8} />
              <span className="label-text">Notebook</span>
            </button>
            <div className="topbar-meta">
              <Clock3 size={15} strokeWidth={1.8} />
              <span className="label-text">{topbarLabel}</span>
            </div>
            <button className="ghost-button" aria-label="Reset notebook" onClick={resetNotebook}>
              <RotateCcw size={15} strokeWidth={1.8} />
              <span className="label-text">Reset</span>
            </button>
            {canDelete && (
              <button className="ghost-button danger" aria-label="Delete page" onClick={deleteActivePage}>
                <Trash2 size={15} strokeWidth={1.8} />
                <span className="label-text">Delete</span>
              </button>
            )}
          </header>

          {isSettingsActive ? (
            <SettingsPage processSide={processSide} storySource={storySource} />
          ) : (
            <div className="doc-scroll">
              <article className="story-page">
                <div
                  className={cx(
                    "doc-cover",
                    activePage.cover && "has-image",
                    !activeCoverLoaded && "loading",
                  )}
                  data-tone={activePage.tone}
                  style={activePage.cover?.color ? { backgroundColor: activePage.cover.color } : undefined}
                  data-cover-preloaded={activeCoverPreloaded ? "true" : "false"}
                >
                  {activePage.cover && (
                    <img
                      key={activeCoverKey}
                      className="cover-image"
                      data-cover-key={activeCoverKey}
                      src={activeCoverUrl}
                      alt={activePage.cover.alt}
                      decoding="async"
                      fetchPriority="high"
                      loading="eager"
                      onError={() => markRenderedCoverReady(activeCoverUrl, activeCoverKey)}
                      onLoad={(event) => settleRenderedCover(event, activeCoverUrl, activeCoverKey)}
                      ref={(image) => {
                        if (!image || !image.complete || !image.naturalWidth) return;
                        if (renderedCoverKeys.has(activeCoverKey)) return;
                        if (image.decode) {
                          image.decode().then(
                            () => markRenderedCoverReady(activeCoverUrl, activeCoverKey),
                            () => markRenderedCoverReady(activeCoverUrl, activeCoverKey),
                          );
                          return;
                        }
                        markRenderedCoverReady(activeCoverUrl, activeCoverKey);
                      }}
                      style={{ objectPosition: coverObjectPosition(activePage.cover) }}
                    />
                  )}
                  <div className="cover-scrim" />
                  <div className="cover-grain" />
                  {!activeCoverLoaded && (
                    <div className="cover-loading-state" aria-label="Loading cover image">
                      <span />
                    </div>
                  )}
                  <div className="cover-actions">
                    <button className="cover-action" type="button" aria-label="Change cover" onClick={() => setCoverPickerOpen(true)}>
                      <ImageIcon size={15} strokeWidth={1.8} />
                      Change
                    </button>
                    <button className="cover-action" type="button" aria-label="Reposition cover" onClick={openCurrentCoverReposition}>
                      <Move size={15} strokeWidth={1.8} />
                      Reposition
                    </button>
                  </div>
                  {activePage.cover?.creditName && (
                    <a
                      className="cover-credit"
                      href={activePage.cover.creditUrl || activePage.cover.unsplashUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Photo by {activePage.cover.creditName} on Unsplash
                    </a>
                  )}
                  <div className="doc-title-row">
                    <textarea
                      className="title-input"
                      ref={titleRef}
                      value={activePage.title}
                      rows={1}
                      aria-label="Page title"
                      placeholder="Untitled"
                      onChange={(event) => updateActivePage({ title: event.target.value })}
                    />
                  </div>
                </div>
                <div className="doc-frame">
                  <EditorPane page={activePage} theme={theme} onChange={updatePageBlocks} />
                </div>
              </article>
            </div>
          )}
        </main>
        {coverPickerOpen && (
          <CoverPickerModal
            query={coverQuery}
            results={coverResults}
            selected={selectedCover}
            status={coverSearchStatus}
            source={coverSource}
            onQueryChange={setCoverQuery}
            onSearch={submitCoverSearch}
            onSelect={setSelectedCover}
            onApply={applySelectedCover}
            onClose={() => setCoverPickerOpen(false)}
          />
        )}
        {repositionCover && (
          <CoverRepositionModal
            cover={repositionCover}
            onChange={setRepositionCover}
            onSave={saveCoverPosition}
            onCancel={() => setRepositionCover(null)}
          />
        )}
      </div>
    </MantineProvider>
  );
}
