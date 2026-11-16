import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAdmin, RequireAuth } from './components/AuthGuard.tsx';
import { Layout } from './components/Layout.tsx';
import { AcceptInvitePage, LoginPage, NotFoundPage } from './pages/AuthPages.tsx';
import { DevelopersPage } from './pages/DevelopersPage.tsx';
import { NotificationsPage } from './pages/NotificationsPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { ProjectDetailPage } from './pages/ProjectDetailPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { PullRequestPage } from './pages/PullRequestPage.tsx';
import { RepositoryPage } from './pages/RepositoryPage.tsx';
import { RiskCenterPage } from './pages/RiskCenterPage.tsx';
import { LoadingBlock } from './components/ui.tsx';

// Setup and settings are visited rarely; keep them out of the main bundle.
const SetupWizard = lazy(() =>
  import('./pages/setup/SetupWizard.tsx').then((m) => ({ default: m.SetupWizard })),
);
const settings = () => import('./pages/settings/SettingsPages.tsx');
const SettingsLayout = lazy(() => settings().then((m) => ({ default: m.SettingsLayout })));
const GithubSettings = lazy(() => settings().then((m) => ({ default: m.GithubSettings })));
const RepositoriesSettings = lazy(() =>
  settings().then((m) => ({ default: m.RepositoriesSettings })),
);
const AiSettingsPage = lazy(() => settings().then((m) => ({ default: m.AiSettingsPage })));
const NotificationSettings = lazy(() =>
  settings().then((m) => ({ default: m.NotificationSettings })),
);
const UsersSettings = lazy(() => settings().then((m) => ({ default: m.UsersSettings })));
const SystemStatusPage = lazy(() => settings().then((m) => ({ default: m.SystemStatusPage })));
const AuditLogPage = lazy(() => settings().then((m) => ({ default: m.AuditLogPage })));

function L({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingBlock />}>{children}</Suspense>;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <L>
            <SetupWizard />
          </L>
        }
      />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<AcceptInvitePage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="repositories/:id" element={<RepositoryPage />} />
          <Route path="pull-requests/:id" element={<PullRequestPage />} />
          <Route path="risk" element={<RiskCenterPage />} />
          <Route path="developers" element={<DevelopersPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route
            path="settings"
            element={
              <RequireAdmin>
                <L>
                  <SettingsLayout />
                </L>
              </RequireAdmin>
            }
          >
            <Route index element={<Navigate to="github" replace />} />
            <Route
              path="github"
              element={
                <L>
                  <GithubSettings />
                </L>
              }
            />
            <Route
              path="repositories"
              element={
                <L>
                  <RepositoriesSettings />
                </L>
              }
            />
            <Route
              path="ai"
              element={
                <L>
                  <AiSettingsPage />
                </L>
              }
            />
            <Route
              path="notifications"
              element={
                <L>
                  <NotificationSettings />
                </L>
              }
            />
            <Route
              path="users"
              element={
                <L>
                  <UsersSettings />
                </L>
              }
            />
            <Route
              path="system"
              element={
                <L>
                  <SystemStatusPage />
                </L>
              }
            />
            <Route
              path="audit"
              element={
                <L>
                  <AuditLogPage />
                </L>
              }
            />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
