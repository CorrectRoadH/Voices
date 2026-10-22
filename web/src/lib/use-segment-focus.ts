// @concord-file
// @concord-implements docs/feature/sentence-links/use-case/copy-sentence-link.md
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export function useSegmentFocus({
  anchor,
  viewKey,
  ready,
  panelRef,
  playerPanelRef,
  onPositioned,
}: {
  anchor: string | null;
  viewKey: string;
  ready: boolean;
  panelRef: RefObject<HTMLDivElement | null>;
  playerPanelRef: RefObject<HTMLDivElement | null>;
  onPositioned: () => void;
}) {
  const animation = useRef<Animation | null>(null);
  const [positionedView, setPositionedView] = useState<string | null>(null);
  useEffect(() => () => animation.current?.cancel(), [viewKey]);

  const position = useCallback(
    (id: string) => {
      const panel = panelRef.current;
      if (!panel) return false;
      const element = panel.querySelector<HTMLElement>(`#${CSS.escape(`segment-${id}`)}`);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const toolbarHeight =
        panel.querySelector(".transcript-search")?.getBoundingClientRect().height ?? 0;
      if (getComputedStyle(panel).overflowY === "auto") {
        panel.scrollBy({
          top:
            rect.top +
            rect.height / 2 -
            panel.getBoundingClientRect().top -
            (panel.clientHeight + toolbarHeight) / 2,
          behavior: "instant",
        });
      } else {
        const bottom = playerPanelRef.current?.getBoundingClientRect().top ?? window.innerHeight;
        window.scrollBy({
          top: rect.top + rect.height / 2 - Math.min(bottom, window.innerHeight) / 2,
          behavior: "instant",
        });
      }
      animation.current?.cancel();
      const color = "color-mix(in oklch, var(--primary) 22%, transparent)";
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      animation.current = element.animate(
        [
          { backgroundColor: color },
          { backgroundColor: color, offset: reduced ? 1 : 0.35 },
          { backgroundColor: reduced ? color : "transparent" },
        ],
        { duration: reduced ? 1200 : 1800, easing: "ease-out" },
      );
      return true;
    },
    [panelRef, playerPanelRef],
  );

  useEffect(() => {
    if (!ready || !anchor) return;
    let cancelled = false;
    let frame = 0;
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        if (!position(anchor)) return;
        onPositioned();
        setPositionedView(viewKey);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [anchor, viewKey, ready, position, onPositioned]);

  return { position, positioned: !anchor || positionedView === viewKey };
}
