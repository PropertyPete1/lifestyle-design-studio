import { cn } from "@/lib/utils";
import { CheckCircle2, Clock, Send, XCircle } from "lucide-react";

type Status = "pending" | "confirmed" | "posted" | "failed";

const MAP: Record<Status, { label: string; icon: typeof Clock; cls: string }> = {
  pending: {
    label: "Pending confirmation",
    icon: Clock,
    cls: "bg-muted/60 text-muted-foreground border-border",
  },
  confirmed: {
    label: "Confirmed · Queued",
    icon: Send,
    cls: "bg-primary/12 text-primary border-primary/30",
  },
  posted: {
    label: "Posted",
    icon: CheckCircle2,
    cls: "bg-emerald-500/12 text-emerald-400 border-emerald-500/30",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    cls: "bg-destructive/12 text-destructive border-destructive/30",
  },
};

export default function StatusBadge({ status }: { status: Status }) {
  const cfg = MAP[status] ?? MAP.pending;
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
        cfg.cls
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {cfg.label}
    </span>
  );
}
