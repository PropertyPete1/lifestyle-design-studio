import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { formatViews } from "@/lib/format";
import { Eye, Loader2, RefreshCw, TrendingDown, TrendingUp, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Streamdown } from "streamdown";

const NETWORK_LABEL: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

interface AnalystData {
  brandMedians?: Record<string, number>;
  flaggedAvgSkipRate?: number | null;
  topPerformerAvgSkipRate?: number | null;
  underperformers?: Array<{
    brand: string;
    views: number;
    brandMedian: number;
    vsMedian: number;
    skipRate: number | null;
    caption: string;
  }>;
  topPerformers?: Array<{
    brand: string;
    views: number;
    vsMedian: number;
    skipRate: number | null;
    caption: string;
  }>;
}

export default function PerformancePage() {
  const utils = trpc.useUtils();
  const latest = trpc.analyst.latest.useQuery();
  const metrics = trpc.analyst.metrics.useQuery();
  const run = trpc.analyst.run.useMutation({
    onSuccess: res => {
      if (res.ok) {
        toast.success(`Analyzed ${res.ingested} posts across your brands.`);
        utils.analyst.latest.invalidate();
        utils.analyst.metrics.invalidate();
      } else {
        toast.error(res.error ?? "Analyst run failed.");
      }
    },
    onError: e => toast.error(e.message),
  });

  const data = (latest.data?.data ?? null) as AnalystData | null;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 pb-28 sm:px-8 sm:py-12 sm:pb-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl">Performance</h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">
            The AI analyst studies views across every brand and platform, judges each post against
            its own brand&apos;s typical reach, and recommends how to raise views. Skip rate and
            watch time are the levers it watches most.
          </p>
        </div>
        <Button
          onClick={() => run.mutate({ days: 7 })}
          disabled={run.isPending}
          className="gap-2"
        >
          {run.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {run.isPending ? "Analyzing…" : "Run analysis"}
        </Button>
      </header>

      {/* Latest insight */}
      {latest.isLoading ? (
        <div className="h-40 animate-pulse rounded-2xl border border-border/60 bg-card" />
      ) : !latest.data ? (
        <div className="rounded-2xl border border-border/60 bg-card p-10 text-center">
          <Sparkles className="mx-auto h-7 w-7 text-primary" />
          <p className="mt-4 font-display text-2xl">No analysis yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Run the first analysis to pull your recent reels from every brand and get a strategy
            report. After that it runs automatically each morning.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/60 bg-card p-6 sm:p-8">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-luxe text-muted-foreground">
              Report · {latest.data.runDate}
            </span>
          </div>
          <div className="prose prose-sm prose-invert max-w-none prose-headings:font-display prose-headings:text-primary prose-strong:text-foreground">
            <Streamdown>{latest.data.summary}</Streamdown>
          </div>
        </div>
      )}

      {/* Per-brand medians + skip correlation */}
      {data?.brandMedians && Object.keys(data.brandMedians).length > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-border/60 bg-card p-6">
            <p className="text-[10px] uppercase tracking-luxe text-muted-foreground">
              Per-brand median views
            </p>
            <div className="mt-4 space-y-2">
              {Object.entries(data.brandMedians).map(([brand, med]) => (
                <div key={brand} className="flex items-center justify-between text-sm">
                  <span className="truncate text-muted-foreground">{brand}</span>
                  <span className="font-medium">{formatViews(med)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card p-6">
            <p className="text-[10px] uppercase tracking-luxe text-muted-foreground">
              Skip rate — the reach lever
            </p>
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-3 text-sm">
                <TrendingDown className="h-4 w-4 text-destructive" />
                <span className="text-muted-foreground">Underperformers avg skip</span>
                <span className="ml-auto font-medium">
                  {data.flaggedAvgSkipRate != null ? `${data.flaggedAvgSkipRate}%` : "—"}
                </span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <TrendingUp className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Top performers avg skip</span>
                <span className="ml-auto font-medium">
                  {data.topPerformerAvgSkipRate != null ? `${data.topPerformerAvgSkipRate}%` : "—"}
                </span>
              </div>
              <p className="pt-1 text-xs text-muted-foreground">
                Lower skip rate = more reach. Tighten the first 1–2 seconds to keep viewers.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Recent post metrics table */}
      <div className="mt-6 rounded-2xl border border-border/60 bg-card">
        <div className="border-b border-border/60 px-6 py-4">
          <p className="font-display text-xl">Recent posts</p>
          <p className="text-xs text-muted-foreground">
            Latest snapshot per post across your connected brands.
          </p>
        </div>
        {metrics.isLoading ? (
          <div className="p-6">
            <div className="h-40 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : !metrics.data?.length ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No metrics captured yet. Run the analysis to pull them in.
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {metrics.data.map(m => (
              <div key={`${m.network}:${m.networkPostId}`} className="flex items-center gap-4 px-6 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-accent px-2 py-0.5 text-accent-foreground">
                      {NETWORK_LABEL[m.network] ?? m.network}
                    </span>
                    <span className="truncate text-muted-foreground">{m.brandLabel}</span>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {m.captionSnippet || "—"}
                  </p>
                </div>
                <div className="hidden shrink-0 text-right sm:block">
                  <p className="text-[10px] uppercase tracking-luxe text-muted-foreground">Skip</p>
                  <p className="text-sm font-medium">
                    {m.skipRate != null ? `${m.skipRate}%` : "—"}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="flex items-center justify-end gap-1 text-sm font-medium">
                    <Eye className="h-3.5 w-3.5 text-primary" /> {formatViews(m.views)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatViews(m.reach)} reach
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
