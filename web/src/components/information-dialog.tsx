// @concord-file
// @concord-implements docs/feature/interface-interactions/ui.md
import type { ReactNode } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function InformationDialog({
  title,
  description,
  label = title,
  children,
}: {
  title: string;
  description: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>{label}</DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
