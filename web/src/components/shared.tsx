// @concord-file
// @concord-implements docs/feature/interface-interactions/ui.md
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from "./ui/alert-dialog";
import { tr } from "@/lib/i18n";
import { Spinner } from "./ui/spinner";
import { AudioLines, CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { notify } from "@/lib/notify";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { stateName } from "@/lib/format";
export function Status({ value }: { value: string }) {
  return (
    <Badge
      variant={
        ["failed", "uncertain", "restore_hold"].includes(value)
          ? "destructive"
          : value === "succeeded" || value === "ready"
            ? "secondary"
            : "outline"
      }
    >
      {[
        "preparing",
        "queued",
        "running",
        "uploading",
        "submitting",
        "polling",
        "normalizing",
      ].includes(value) && <Spinner data-icon="inline-start" aria-hidden="true" />}
      {value === "ready" || value === "succeeded" ? (
        <CheckCircle2 data-icon="inline-start" />
      ) : null}
      {stateName(value)}
    </Badge>
  );
}
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  useEffect(() => {
    if (message) notify(message, true);
  }, [message]);
  return message && retry ? (
    <Button variant="outline" size="sm" onClick={retry}>
      <RefreshCw data-icon="inline-start" />
      {tr("重新加载")}
    </Button>
  ) : null;
}

export function Loading({
  title = tr("正在加载"),
  description,
  compact = false,
}: {
  title?: string;
  description?: string;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite" aria-label={title}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        <span>{title}</span>
      </div>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {!compact && (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-16 w-4/5" />
          <Skeleton className="h-16 w-3/5 self-end" />
        </div>
      )}
    </div>
  );
}
export function EmptyState({
  title = tr("还没有录音"),
  description,
  children,
}: {
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AudioLines />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading mb-6 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}
export function Modal({
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function ConfirmationDialog({
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function More({
  cursor,
  loading,
  onLoad,
}: {
  cursor?: string | null;
  loading?: boolean;
  onLoad: (cursor: string) => void;
}) {
  return cursor ? (
    <div className="flex justify-center py-4">
      <Button
        variant="outline"
        aria-busy={loading}
        disabled={loading}
        onClick={() => onLoad(cursor)}
      >
        {loading && <Spinner data-icon="inline-start" aria-hidden="true" />}
        {tr("加载更多")}{" "}
      </Button>
    </div>
  ) : null;
}
