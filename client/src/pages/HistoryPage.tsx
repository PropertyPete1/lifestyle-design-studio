import StatusBadge from "@/components/StatusBadge";
import { CITY_LABEL, formatDateNice, formatViews } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Eye, MapPin } from "lucide-react";

export default function HistoryPage() {
  const { data, isLoading } = trpc.history.list.useQuery();

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="mb-8">
        <h1 className="font-display text-4xl sm:text-5xl">Rotation History</h1>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          Every reel that has been confirmed and scheduled, newest first. This log powers the
          30-day no-repeat rotation.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-20 animate-pulse rounded-xl border border-border/60 bg-card" />
          ))}
        </div>
      ) : !data?.length ? (
        <div className="rounded-2xl border border-border/60 bg-card p-12 text-center text-muted-foreground">
          No reposts yet. Confirm today&apos;s picks to start your rotation history.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
          {data.map((r, idx) => (
            <div
              key={r.id}
              className={`flex items-center gap-4 px-5 py-4 ${
                idx !== data.length - 1 ? "border-b border-border/50" : ""
              }`}
            >
              <div className="h-16 w-12 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted">
                {r.thumbnailUrl ? (
                  <img src={r.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="h-3.5 w-3.5 text-primary" />
                  <span className="font-medium">{CITY_LABEL[r.city]}</span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{formatDateNice((r.scheduledFor as number) || r.confirmedAt)}</span>
                  <span className="flex items-center gap-1">
                    <Eye className="h-3 w-3" /> {formatViews(r.viewsAtRepost)}
                  </span>
                </div>
              </div>
              <StatusBadge status={r.status as "confirmed" | "posted" | "failed"} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
