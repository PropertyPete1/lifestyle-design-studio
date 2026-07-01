import { CITY_LABEL, formatViews } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Eye, MapPin } from "lucide-react";
import { useState } from "react";

type CityFilter = "all" | "austin" | "san_antonio" | "dallas";

export default function LibraryPage() {
  const [filter, setFilter] = useState<CityFilter>("all");
  const { data: stats } = trpc.library.stats.useQuery();
  const { data, isLoading } = trpc.library.list.useQuery(
    filter === "all" ? {} : { city: filter }
  );

  const tabs: { key: CityFilter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: stats?.total },
    { key: "austin", label: "Austin", count: stats?.austin },
    { key: "san_antonio", label: "San Antonio", count: stats?.sanAntonio },
    { key: "dallas", label: "Dallas–Fort Worth", count: stats?.dallas },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-8 pb-28 sm:px-8 sm:py-12 sm:pb-12">
      <header className="mb-6">
        <h1 className="font-display text-4xl sm:text-5xl">Video Library</h1>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          Your reels, classified by market via AI vision reading on-screen location text, ranked by
          Instagram views.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm transition-colors",
              filter === t.key
                ? "border-primary/40 bg-primary/12 text-primary"
                : "border-border bg-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className="ml-2 text-xs opacity-70">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="aspect-[9/16] animate-pulse rounded-xl border border-border/60 bg-card" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {data?.map((v, idx) => (
            <a
              key={v.id}
              href={v.permalink ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="group relative overflow-hidden rounded-xl border border-border/60 bg-card"
            >
              <div className="aspect-[9/16] overflow-hidden bg-muted">
                {v.thumbnailUrl ? (
                  <img
                    src={v.thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                    style={{ transitionTimingFunction: "var(--ease-out)" }}
                  />
                ) : null}
              </div>
              {/* rank chip */}
              {filter !== "all" && idx === 0 && (
                <span className="absolute left-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  Top pick
                </span>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                <div className="flex items-center gap-1 text-xs text-white">
                  <Eye className="h-3 w-3" /> {formatViews(v.views)}
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-white/70">
                  <MapPin className="h-2.5 w-2.5" /> {CITY_LABEL[v.city]}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
