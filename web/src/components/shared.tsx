import { tr } from "@/lib/i18n";
import { AlertCircle, AudioLines, CheckCircle2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
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
      {value === "ready" || value === "succeeded" ? (
        <CheckCircle2 data-icon="inline-start" />
      ) : null}
      {stateName(value)}
    </Badge>
  );
}
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{tr("暂时无法完成")}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            <RefreshCw data-icon="inline-start" />
            {tr("重新加载")}{" "}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
export function Loading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label={tr("正在加载")}>
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
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
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
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
      <Button variant="outline" disabled={loading} onClick={() => onLoad(cursor)}>
        {tr("加载更多")}{" "}
      </Button>
    </div>
  ) : null;
}
