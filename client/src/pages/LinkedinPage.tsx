import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { formatScheduledCdt, formatDateNice } from "@/lib/format";
import { Linkedin, Loader2, RefreshCw, Save, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const TOPIC_LABEL: Record<string, string> = {
  why_agents_leave: "Why agents leave brokerages",
  leadership_culture: "Leadership and culture",
  income_potential: "Income potential",
  mindset_motivation: "Mindset and motivation",
  wish_i_knew: "What I wish I knew earlier",
  time_to_level_up: "Signs it's time to level up",
};

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    posted: { label: "Posted", className: "bg-emerald-500/15 text-emerald-600", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    scheduled: { label: "Auto-scheduled", className: "bg-sky-500/15 text-sky-600", icon: <Clock className="h-3.5 w-3.5" /> },
    draft: { label: "Draft", className: "bg-amber-500/15 text-amber-600", icon: <Clock className="h-3.5 w-3.5" /> },
    failed: { label: "Failed", className: "bg-red-500/15 text-red-600", icon: <AlertCircle className="h-3.5 w-3.5" /> },
  };
  const s = map[status] ?? map.draft;
  return (
    <Badge variant="secondary" className={`gap-1 ${s.className}`}>
      {s.icon}
      {s.label}
    </Badge>
  );
}

function wordCount(s: string) {
  return s.split(/\s+/).filter(Boolean).length;
}

type BrandResult = {
  blogId: number;
  label: string;
  ok: boolean;
  postId?: string | null;
  publishAt?: string;
  error?: string;
};

function BrandResults({ raw }: { raw?: string | null }) {
  if (!raw) return null;
  let items: BrandResult[] = [];
  try {
    items = JSON.parse(raw) as BrandResult[];
  } catch {
    return null;
  }
  if (!Array.isArray(items) || items.length === 0) return null;
  const time = (s?: string) => (s && s.includes("T") ? s.split("T")[1]?.slice(0, 5) : undefined);
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.map(b => (
        <span
          key={b.blogId}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${
            b.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600"
          }`}
          title={b.error ?? undefined}
        >
          {b.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {b.label}
          {time(b.publishAt) ? ` · ${time(b.publishAt)}` : ""}
        </span>
      ))}
    </div>
  );
}

export default function LinkedinPage() {
  const utils = trpc.useUtils();
  const today = trpc.linkedin.today.useQuery(undefined, { refetchOnWindowFocus: false });
  const history = trpc.linkedin.history.useQuery();

  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (today.data?.body != null && !dirty) setDraft(today.data.body);
  }, [today.data?.body, dirty]);

  const save = trpc.linkedin.updateBody.useMutation({
    onSuccess: () => {
      toast.success("Post saved. This is what will publish at 2 PM CT.");
      setDirty(false);
      utils.linkedin.today.invalidate();
      utils.linkedin.history.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  const regenerate = trpc.linkedin.regenerate.useMutation({
    onSuccess: res => {
      toast.success("Regenerated a fresh post in your voice.");
      setDraft(res.body);
      setDirty(false);
      utils.linkedin.today.invalidate();
      utils.linkedin.history.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  const post = today.data;
  const isPosted = post?.status === "posted";

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-8 pb-28 sm:px-8 sm:py-12 sm:pb-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-luxe text-muted-foreground">Recruiting on LinkedIn</p>
          <h1 className="font-display text-3xl text-primary flex items-center gap-2">
            <Linkedin className="h-7 w-7" /> LinkedIn Posts
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            One text-only recruiting post publishes automatically every day, written in your voice to attract
            realtors to Lifestyle Design Realty. It posts to every LinkedIn page you have connected in Metricool,
            staggered 30 minutes apart starting at 2 PM CT. It rotates through your six topics and learns from what
            performs best. You can edit or regenerate today's post below before it goes out.
          </p>
        </div>
      </header>

      {/* Today's post */}
      <Card className="mb-10 p-6">
        {today.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparing today's post…
          </div>
        ) : !post ? (
          <p className="text-muted-foreground">No post yet. It will be generated shortly.</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={post.status} />
                <Badge variant="outline">{TOPIC_LABEL[post.topic] ?? post.topic}</Badge>
                <span className="text-xs text-muted-foreground">
                  {formatDateNice(post.postDate)} · publishes {formatScheduledCdt(post.scheduledFor)}
                </span>
              </div>
              <span className={`text-xs ${wordCount(draft) > 150 ? "text-red-600" : "text-muted-foreground"}`}>
                {wordCount(draft)} / 150 words
              </span>
            </div>

            <Textarea
              value={draft}
              disabled={isPosted}
              onChange={e => {
                setDraft(e.target.value);
                setDirty(true);
              }}
              className="min-h-[280px] resize-y font-sans text-[15px] leading-relaxed"
            />

            {isPosted ? (
              <p className="mt-4 text-sm text-emerald-600 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" /> This post has been published to your LinkedIn page(s).
              </p>
            ) : (
              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  onClick={() => save.mutate({ id: post.id, body: draft })}
                  disabled={save.isPending || !dirty || !draft.trim()}
                >
                  {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save edits
                </Button>
                <Button
                  variant="outline"
                  onClick={() => regenerate.mutate({ id: post.id, postDate: post.postDate })}
                  disabled={regenerate.isPending}
                >
                  {regenerate.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Regenerate
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* History */}
      <h2 className="mb-4 font-display text-xl text-primary">Recent posts</h2>
      {history.isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !history.data?.length ? (
        <p className="text-sm text-muted-foreground">No posts yet.</p>
      ) : (
        <div className="space-y-3">
          {history.data.map(p => (
            <Card key={p.id} className="p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusPill status={p.status} />
                <Badge variant="outline">{TOPIC_LABEL[p.topic] ?? p.topic}</Badge>
                <span className="text-xs text-muted-foreground">
                  {formatDateNice(p.postDate)}
                  {p.status === "posted" && p.postedAt ? ` · posted ${formatScheduledCdt(p.postedAt)}` : ""}
                </span>
                {(p.reactions > 0 || p.comments > 0 || p.impressions > 0) && (
                  <span className="text-xs text-muted-foreground">
                    {p.impressions} impressions · {p.reactions} reactions · {p.comments} comments
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{p.body}</p>
              <BrandResults raw={p.brandResults} />
              {p.status === "failed" && p.errorReason && (
                <p className="mt-2 text-xs text-red-600">Reason: {p.errorReason}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
