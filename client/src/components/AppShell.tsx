import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { cn } from "@/lib/utils";
import { CalendarCheck, History, Loader2, LogOut, Clapperboard, ShieldAlert, LineChart } from "lucide-react";
import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import InstallAppButton from "./InstallAppButton";

const NAV = [
  { href: "/", label: "Daily Picks", icon: CalendarCheck },
  { href: "/performance", label: "Performance", icon: LineChart },
  { href: "/history", label: "Rotation History", icon: History },
  { href: "/library", label: "Video Library", icon: Clapperboard },
];

function Brand() {
  return (
    <div className="px-6 py-7 border-b border-border/60">
      <p className="font-display text-2xl leading-none text-primary">Lifestyle Design</p>
      <p className="mt-1 text-[10px] uppercase tracking-luxe text-muted-foreground">
        Daily Reels Studio
      </p>
    </div>
  );
}

function GateScreen({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [location] = useLocation();

  if (loading) {
    return (
      <GateScreen>
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
      </GateScreen>
    );
  }

  if (!isAuthenticated) {
    return (
      <GateScreen>
        <p className="font-display text-4xl text-primary">Lifestyle Design</p>
        <p className="mt-2 text-xs uppercase tracking-luxe text-muted-foreground">
          Daily Reels Studio
        </p>
        <p className="mt-8 text-sm text-muted-foreground">
          A private studio for your daily Instagram reposting. Owner access only.
        </p>
        <a
          href={getLoginUrl()}
          className="mt-8 inline-flex items-center justify-center rounded-full bg-primary px-8 py-3 text-sm font-medium text-primary-foreground transition-transform active:scale-[0.97]"
          style={{ transitionTimingFunction: "var(--ease-out)" }}
        >
          Enter Studio
        </a>
      </GateScreen>
    );
  }

  if (user?.role !== "admin") {
    return (
      <GateScreen>
        <ShieldAlert className="mx-auto h-8 w-8 text-destructive" />
        <p className="mt-4 font-display text-3xl">Restricted</p>
        <p className="mt-3 text-sm text-muted-foreground">
          This studio is limited to the account owner.
        </p>
        <button
          onClick={() => logout()}
          className="mt-6 text-xs uppercase tracking-luxe text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>
      </GateScreen>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border/60 bg-sidebar">
        <Brand />
        <nav className="flex-1 px-3 py-5 space-y-1">
          {NAV.map(item => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <Icon className={cn("h-4 w-4", active && "text-primary")} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-3 py-5 border-t border-border/60">
          <div className="px-3 pb-3">
            <p className="text-sm truncate">{user?.name ?? "Owner"}</p>
            <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
          </div>
          <button
            onClick={() => logout()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden sticky top-0 z-20 flex items-center justify-between border-b border-border/60 bg-background/85 px-5 py-3 backdrop-blur">
          <span className="font-display text-xl text-primary">Lifestyle Design</span>
          <div className="flex items-center gap-3">
            <InstallAppButton />
            <button onClick={() => logout()} className="text-muted-foreground" aria-label="Sign out">
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </header>

        <main className="flex-1 min-w-0">{children}</main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden sticky bottom-0 z-20 grid grid-cols-4 border-t border-border/60 bg-background/90 backdrop-blur">
          {NAV.map(item => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex flex-col items-center gap-1 py-2.5 text-[11px]",
                  active ? "text-primary" : "text-muted-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
                {item.label.split(" ")[0]}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
