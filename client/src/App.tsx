import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import AppShell from "./components/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import HistoryPage from "./pages/HistoryPage";
import Home from "./pages/Home";
import LibraryPage from "./pages/LibraryPage";
import PerformancePage from "./pages/PerformancePage";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/performance" component={PerformancePage} />
      <Route path="/history" component={HistoryPage} />
      <Route path="/library" component={LibraryPage} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster position="top-center" />
          <AppShell>
            <Router />
          </AppShell>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
