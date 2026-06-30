import StatusBadge from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CITY_LABEL, formatScheduledCdt, formatViews } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  Eye,
  Loader2,
  MapPin,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type PickWithVideo = {
  id: number;
  city: "austin" | "san_antonio";
  postId: string;
  refreshedCaption: string | null;
  selectionMode: string;
  scheduledFor: number | null;
  status: "pending" | "confirmed" | "posted" | "failed";
  video?: {
    id: number;
    views: number;
    thumbnailUrl: string | null;
    permalink: string | null;
    onscreenText: string | null;
    originalTimestamp: string | null;
    caption: string | null;
  };
};

function PickCard({ pick }: { pick: PickWithVideo }) {
  const utils = trpc.useUtils();
  const [caption, setCaption] = useState(pick.refreshedCaption ?? "");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setCaption(pick.refreshedCaption ?? "");
  }, [pick.refreshedCaption, dirty]);

  const editable = pick.status === "pending";

  const saveCaption = trpc.picks.updateCaption.useMutation({
    onSuccess: () => {
      setDirty(false);
      toast.success("Caption saved");
      utils.picks.today.invalidate();
    },
    onError: () => toast.error("Could not save caption"),
  });

  const regen = trpc.picks.regenerateCaption.useMutation({
    onSuccess: data => {
      setCaption(data.caption);
      setDirty(false);
      toast.success("Caption refreshed");
      utils.picks.today.invalidate();
    },
    onError: () => toast.error("Could not refresh caption"),
  });

  const confirm = trpc.picks.confirm.useMutation({
    onSuccess: () => {
      toast.success(`${CITY_LABEL[pick.city]} reel confirmed`);
      utils.picks.today.invalidate();
      utils.history.list.invalidate();
    },
    onError: () => toast.error("Could not confirm"),
  });

  return (
    <div
      className="group relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_24px_60px_-30px_rgba(0,0,0,0.7)]"
    >
      {/* header strip */}
      <div className="flex items-center justify-between px-6 pt-6">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-primary" />
          <span className="text-xs uppercase tracking-luxe text-muted-foreground">
            {CITY_LABEL[pick.city]}
          </span>
        </div>
        <StatusBadge status={pick.status} />
      </div>

      <div className="grid gap-6 p-6 sm:grid-cols-[180px_1fr]">
        {/* thumbnail */}
        <div className="relative">
          <div className="aspect-[9/16] overflow-hidden rounded-xl border border-border/60 bg-muted">
            {pick.video?.thumbnailUrl ? (
              <img
                src={pick.video.thumbnailUrl}
                alt={`${CITY_LABEL[pick.city]} reel`}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                style={{ transitionTimingFunction: "var(--ease-out)" }}
                onError={e => {
                  // If the thumbnail fails to load, swap to a graceful label
                  // instead of leaving an empty block on the card.
                  const el = e.currentTarget;
                  el.style.display = "none";
                  const parent = el.parentElement;
                  if (parent && !parent.querySelector("[data-img-fallback]")) {
                    const div = document.createElement("div");
                    div.setAttribute("data-img-fallback", "true");
                    div.className =
                      "flex h-full items-center justify-center text-xs text-muted-foreground";
                    div.textContent = "Preview unavailable";
                    parent.appendChild(div);
                  }
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                No preview
              </div>
            )}
          </div>
          <div className="mt-3 flex items-center justify-center gap-1.5 text-sm">
            <Eye className="h-4 w-4 text-primary" />
            <span className="font-medium">{formatViews(pick.video?.views ?? 0)}</span>
            <span className="text-muted-foreground">views</span>
          </div>
        </div>

        {/* caption + actions */}
        <div className="flex flex-col">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs uppercase tracking-luxe text-muted-foreground">
              Caption
            </label>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" />
              AI-refreshed
            </div>
          </div>

          <Textarea
            value={caption}
            disabled={!editable}
            onChange={e => {
              setCaption(e.target.value);
              setDirty(true);
            }}
            className="min-h-[180px] flex-1 resize-none bg-background/60 font-sans text-sm leading-relaxed"
          />

          <p className="mt-2 text-[11px] text-muted-foreground">
            Scheduled to post at{" "}
            <span className="text-foreground">{formatScheduledCdt(pick.scheduledFor)}</span>
            {pick.selectionMode === "fallback" && (
              <span className="ml-2 text-primary">· library cycled (all within 30-day cooldown)</span>
            )}
          </p>

          {editable ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => confirm.mutate({ pickId: pick.id })}
                disabled={confirm.isPending}
                className="rounded-full px-6 transition-transform active:scale-[0.97]"
                style={{ transitionTimingFunction: "var(--ease-out)" }}
              >
                {confirm.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Confirm &amp; Schedule
              </Button>
              <Button
                variant="outline"
                onClick={() => saveCaption.mutate({ pickId: pick.id, caption })}
                disabled={!dirty || saveCaption.isPending}
                className="rounded-full bg-transparent"
              >
                {saveCaption.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save edits
              </Button>
              <Button
                variant="ghost"
                onClick={() => regen.mutate({ pickId: pick.id })}
                disabled={regen.isPending}
                className="rounded-full text-muted-foreground"
              >
                <RefreshCw className={cn("h-4 w-4", regen.isPending && "animate-spin")} />
                Regenerate
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              {pick.status === "posted"
                ? "Published to Instagram."
                : "Locked in. The studio will publish at the scheduled time."}
              {pick.video?.permalink && (
                <a
                  href={pick.video.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1 text-primary hover:underline"
                >
                  View original
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { data, isLoading } = trpc.picks.today.useQuery();

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 pb-28 sm:px-8 sm:py-12 sm:pb-12">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-luxe text-muted-foreground">{today}</p>
        <h1 className="mt-2 font-display text-4xl sm:text-5xl">Today&apos;s Picks</h1>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          Two top-performing reels — one for each market — selected by Instagram views with a
          strict 30-day no-repeat rotation. Review, refine the caption, and confirm.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-6">
          {[0, 1].map(i => (
            <div
              key={i}
              className="h-72 animate-pulse rounded-2xl border border-border/60 bg-card"
            />
          ))}
        </div>
      ) : !data?.picks.length ? (
        <div className="rounded-2xl border border-border/60 bg-card p-12 text-center text-muted-foreground">
          No picks available yet.
        </div>
      ) : (
        <div className="space-y-6">
          {data.picks.map(p => (
            <PickCard key={p.id} pick={p as PickWithVideo} />
          ))}
        </div>
      )}
    </div>
  );
}
