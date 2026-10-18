// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup } from "./ui/dropdown-menu";

export function MessageBubble({ children, metadata, actions }: {
  children: ReactNode; metadata: ReactNode; actions: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const press = useRef<{timer: ReturnType<typeof setTimeout>; x:number; y:number} | null>(null);
  const suppressClick = useRef(false);
  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
    window.removeEventListener("scroll", cancel, true);
    window.removeEventListener("pointerup", cancel);
    window.removeEventListener("pointercancel", cancel);
  }, []);
  useEffect(() => () => cancel(), [cancel]);
  return <div className="segment-bubble" data-menu-open={open || undefined}
    onPointerDown={(event) => {
      cancel();
      suppressClick.current = false;
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,a,[role=menu],button:not(.segment-text)")) return;
      window.addEventListener("scroll", cancel, {capture:true, passive:true});
      window.addEventListener("pointerup", cancel);
      window.addEventListener("pointercancel", cancel);
      press.current = {x:event.clientX,y:event.clientY,timer:setTimeout(() => {
        cancel();
        suppressClick.current = true;
        setOpen(true);
      }, 500)};
    }}
    onPointerMove={(event) => {
      if (press.current && Math.hypot(event.clientX-press.current.x,event.clientY-press.current.y)>10) cancel();
    }}
    onPointerUp={cancel}
    onPointerCancel={cancel}
    onClickCapture={(event) => {
      if (suppressClick.current && event.currentTarget.contains(event.target as Node)) {
        suppressClick.current = false;
        event.preventDefault(); event.stopPropagation();
      }
    }}
    onContextMenu={(event) => {
      if ((event.target as HTMLElement).closest("input,textarea,[role=menu]")) return;
      event.preventDefault(); cancel(); setOpen(true);
    }}
    onKeyDown={(event) => {
      if ((event.target as HTMLElement).closest("input,textarea")) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); setOpen(true);
      }
    }}>
    {children}
    <div className="message-meta">
      {metadata}
      <DropdownMenu triggerId={triggerId} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger id={triggerId} render={<Button className="message-more" variant="ghost" size="icon-sm" aria-label="更多操作" />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48"><DropdownMenuGroup>{actions}</DropdownMenuGroup></DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>;
}
