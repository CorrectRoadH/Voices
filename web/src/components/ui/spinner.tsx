import { LoaderCircle } from "lucide-react";
import { cn } from "cn";

export function Spinner({ className, ...props }: React.ComponentProps<typeof LoaderCircle>) {
  return (
    <LoaderCircle
      data-slot="spinner"
      aria-hidden="true"
      className={cn("size-4 shrink-0 motion-safe:animate-spin", className)}
      {...props}
    />
  );
}
