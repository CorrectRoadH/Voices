// @concord-file
// @concord-implements docs/feature/transcription/use-case/read-transcript.md
// @concord-implements docs/feature/transcription/use-case/edit-transcript.md
import { tr } from "@/lib/i18n";
import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { Bubble, BubbleContent } from "./ui/bubble";
import { MessageFooter } from "./ui/message";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
} from "./ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
} from "./ui/dropdown-menu";

export function MessageBubble({
  children,
  metadata,
  actions,
  busy = false,
  self = false,
}: {
  children: ReactNode;
  metadata: ReactNode;
  actions: ReactNode;
  busy?: boolean;
  self?: boolean;
}) {
  return (
    <Bubble variant={self ? "tinted" : "secondary"} className="segment-bubble">
      <ContextMenu
        onOpenChange={(open, details) => {
          const target = details.event.target;
          if (
            open &&
            (!actions || busy || (target instanceof Element && target.closest("input,textarea")))
          )
            details.cancel();
        }}
      >
        <ContextMenuTrigger data-slot="bubble-content" render={<BubbleContent />}>
          {children}
          {(metadata || actions) && (
            <MessageFooter className="justify-end gap-1 px-0">
              {metadata}
              {actions && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        className="message-more"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={tr("更多操作")}
                        disabled={busy}
                        aria-busy={busy}
                      />
                    }
                  >
                    {busy ? <Spinner aria-hidden="true" /> : <MoreHorizontal />}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuGroup>{actions}</DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </MessageFooter>
          )}
        </ContextMenuTrigger>
        {actions && (
          <ContextMenuContent>
            <ContextMenuGroup>{actions}</ContextMenuGroup>
          </ContextMenuContent>
        )}
      </ContextMenu>
    </Bubble>
  );
}
