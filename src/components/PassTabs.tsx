import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMergedPasses, useViewerStore } from '../store/viewerStore';

// How many pixels each arrow click or arrow-key press scrolls the strip.
const SCROLL_STEP = 240;

export function PassTabs() {
  const merged = useMergedPasses();
  const activePass = useViewerStore((s) => s.activePass);
  const setActivePass = useViewerStore((s) => s.setActivePass);
  const selectedCount = useViewerStore((s) => s.selectedFiles.length);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return merged;
    return merged.filter(
      (p) => p.display_name.toLowerCase().includes(q) || p.family.toLowerCase().includes(q)
    );
  }, [merged, query]);

  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; scrollLeft: number; moved: boolean } | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const recomputeEdges = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 2);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    if (merged.length === 0) {
      if (activePass !== null) setActivePass(null);
      return;
    }
    if (!activePass || !merged.some((p) => p.display_name === activePass)) {
      setActivePass(merged[0]!.display_name);
    }
  }, [merged, activePass, setActivePass]);

  // Re-evaluate edge affordance after the visible set changes (content width changes).
  useEffect(() => {
    recomputeEdges();
  }, [visible, recomputeEdges]);

  // Native wheel listener — React's synthetic onWheel is passive, so we can't
  // preventDefault inside it; attaching natively lets the strip eat the wheel
  // and translate it to horizontal scroll for both mice (deltaY) and trackpads
  // (which may send deltaX, deltaY, or both).
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (dx === 0) return;
      e.preventDefault();
      el.scrollLeft += dx;
      recomputeEdges();
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [recomputeEdges]);

  // Scroll the active tab into view whenever it changes so keyboard nav across
  // a long strip doesn't strand the highlighted tab off-screen.
  useEffect(() => {
    if (!activePass) return;
    const el = stripRef.current;
    if (!el) return;
    const active = el.querySelector('.pass-tab.active') as HTMLElement | null;
    if (!active) return;
    const stripRect = el.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < stripRect.left + 8) {
      el.scrollLeft -= stripRect.left + 8 - tabRect.left;
    } else if (tabRect.right > stripRect.right - 8) {
      el.scrollLeft += tabRect.right - (stripRect.right - 8);
    }
    recomputeEdges();
  }, [activePass, recomputeEdges]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el) return;
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, scrollLeft: el.scrollLeft, moved: false };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    const d = dragRef.current;
    if (!el || !d) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 3) d.moved = true;
    el.scrollLeft = d.scrollLeft - dx;
    recomputeEdges();
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return;
    // Navigate within the *visible* (filtered) set so arrow keys stay coherent
    // with what the user sees while a search is active.
    const idx = visible.findIndex((p) => p.display_name === activePass);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = visible[Math.min(visible.length - 1, idx + 1)] ?? visible[0];
      if (next) setActivePass(next.display_name);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = visible[Math.max(0, idx - 1)] ?? visible[0];
      if (prev) setActivePass(prev.display_name);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = visible[0];
      if (first) setActivePass(first.display_name);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = visible[visible.length - 1];
      if (last) setActivePass(last.display_name);
    }
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && visible.length > 0) {
      e.preventDefault();
      setActivePass(visible[0]!.display_name);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
    }
  };

  const scrollBy = (px: number) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollLeft + px, behavior: 'smooth' });
    // recomputeEdges runs again on the natural scroll event below
  };

  const search = (
    <div className="pass-search">
      <input
        type="text"
        spellCheck={false}
        placeholder="filter passes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKey}
      />
      {query && (
        <button
          className="pass-search-clear"
          aria-label="Clear search"
          onClick={() => setQuery('')}
        >
          ×
        </button>
      )}
    </div>
  );

  if (selectedCount === 0) {
    return (
      <div className="pass-strip-wrap">
        {search}
        <div className="pass-strip">
          <div className="pass-empty">Select one or more EXR files to populate passes</div>
        </div>
      </div>
    );
  }
  if (merged.length === 0) {
    return (
      <div className="pass-strip-wrap">
        {search}
        <div className="pass-strip">
          <div className="pass-empty">No passes available</div>
        </div>
      </div>
    );
  }

  return (
    <div className="pass-strip-wrap">
      {search}
      <button
        className={`pass-nav left ${canLeft ? '' : 'hidden'}`}
        aria-label="Scroll passes left"
        onClick={() => scrollBy(-SCROLL_STEP)}
      >
        ◀
      </button>
      <div
        ref={stripRef}
        className="pass-strip scrollable"
        tabIndex={0}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onKeyDown={onKeyDown}
        onScroll={recomputeEdges}
      >
        {visible.length === 0 ? (
          <div className="pass-empty">no match for “{query}”</div>
        ) : (
          visible.map((p) => (
            <button
              key={p.display_name}
              className={`pass-tab ${activePass === p.display_name ? 'active' : ''}`}
              onClick={(e) => {
                if (dragRef.current?.moved) {
                  e.preventDefault();
                  return;
                }
                setActivePass(p.display_name);
              }}
            >
              <span className="fam">{p.family}</span>
              {p.display_name}
            </button>
          ))
        )}
      </div>
      <button
        className={`pass-nav right ${canRight ? '' : 'hidden'}`}
        aria-label="Scroll passes right"
        onClick={() => scrollBy(SCROLL_STEP)}
      >
        ▶
      </button>
    </div>
  );
}
