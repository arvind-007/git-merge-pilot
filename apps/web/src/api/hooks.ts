import {
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { ApiError, api, asList, setCsrfToken } from './client.ts';
import type {
  AcceptInviteRequest,
  AiProvider,
  AiProviderCreate,
  AiSettings,
  AiSettingsUpdate,
  AnalysisHistoryItem,
  AuditLogEntry,
  AuditLogResponse,
  AvailableRepository,
  Developer,
  GithubStatus,
  InviteRequest,
  InviteResponse,
  LoginRequest,
  ManifestRequest,
  ManifestResponse,
  MeResponse,
  NotificationChannel,
  NotificationChannelCreate,
  NotificationItem,
  NotificationRule,
  NotificationRuleInput,
  OrgUser,
  OverviewResponse,
  PrListFilters,
  PrListItem,
  Project,
  ProjectCreate,
  ProjectDetail,
  ProjectOverview,
  ProjectPatch,
  PullRequestDetail,
  Repository,
  RepositoryDetail,
  RepositoryOverview,
  RepositoryPatch,
  RiskCenterResponse,
  SetupAdminRequest,
  SetupStatus,
  SystemStatus,
  TestResult,
  UsageResponse,
  UsersResponse,
  InviteItem,
} from './types.ts';

export const qk = {
  setupStatus: ['setup', 'status'] as const,
  me: ['auth', 'me'] as const,
  githubStatus: ['github', 'status'] as const,
  githubRepos: ['github', 'repositories'] as const,
  repositories: ['repositories'] as const,
  repository: (id: string) => ['repositories', id] as const,
  repositoryOverview: (id: string) => ['repositories', id, 'overview'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  projectOverview: (id: string) => ['projects', id, 'overview'] as const,
  pullRequests: (f: PrListFilters) => ['pull-requests', 'list', f] as const,
  pullRequest: (id: string) => ['pull-requests', id] as const,
  analyses: (id: string) => ['pull-requests', id, 'analyses'] as const,
  overview: ['overview'] as const,
  riskCenter: ['risk-center'] as const,
  developers: ['developers'] as const,
  aiSettings: ['settings', 'ai'] as const,
  aiProviders: ['settings', 'ai', 'providers'] as const,
  usage: ['usage'] as const,
  channels: ['settings', 'notification-channels'] as const,
  rules: ['settings', 'notification-rules'] as const,
  notifications: (unreadOnly: boolean) => ['notifications', { unreadOnly }] as const,
  users: ['users'] as const,
  systemStatus: ['system', 'status'] as const,
  auditLog: (cursor: string | null) => ['audit-log', cursor] as const,
};

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Any 401 means the session is gone: clear "me" so the auth guard redirects to login.
        if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== 'auth') {
          setCsrfToken(null);
          client.setQueryData(qk.me, null);
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry: (count, error) => {
          if (error instanceof ApiError && error.status > 0 && error.status < 500) return false;
          return count < 2;
        },
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
    },
  });
  return client;
}

// ---------------------------------------------------------------------------
// Setup & auth
// ---------------------------------------------------------------------------

export function useSetupStatus() {
  return useQuery({
    queryKey: qk.setupStatus,
    queryFn: async () => {
      const raw = await api.get<
        Partial<SetupStatus> & { setupComplete?: boolean; setupCompleted?: boolean }
      >('/api/setup/status');
      const completed = Boolean(raw.completed ?? raw.setupComplete ?? raw.setupCompleted);
      return {
        completed,
        adminCreated: Boolean(raw.adminCreated ?? completed),
        step: typeof raw.step === 'number' ? raw.step : 1,
      } satisfies SetupStatus;
    },
    staleTime: 60_000,
  });
}

/** Current session; resolves to `null` when signed out (401). */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        const me = await api.get<MeResponse>('/api/auth/me');
        setCsrfToken(me.csrfToken ?? null);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useIsAdmin(): boolean {
  const me = useMe();
  return me.data?.user.role === 'admin';
}

function useSessionMutation<TVars>(fn: (v: TVars) => Promise<MeResponse | null | undefined>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data) => {
      if (data && typeof data === 'object' && 'user' in data) {
        setCsrfToken(data.csrfToken ?? null);
        qc.setQueryData(qk.me, data);
      }
      await qc.invalidateQueries({ queryKey: qk.me });
      await qc.invalidateQueries({ queryKey: qk.setupStatus });
    },
  });
}

export function useLogin() {
  return useSessionMutation((v: LoginRequest) => api.post<MeResponse>('/api/auth/login', v));
}

export function useSetupAdmin() {
  return useSessionMutation((v: SetupAdminRequest) => api.post<MeResponse>('/api/setup/admin', v));
}

export function useAcceptInvite() {
  return useSessionMutation((v: AcceptInviteRequest) =>
    api.post<MeResponse>('/api/auth/invite/accept', v),
  );
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>('/api/auth/logout'),
    onSettled: () => {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(qk.me, null);
    },
  });
}

/** Marks the setup wizard complete ("start monitoring"). */
export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>('/api/setup/complete'),
    onSuccess: async () => {
      qc.setQueryData<SetupStatus>(qk.setupStatus, (s) => ({
        adminCreated: true,
        step: 7,
        ...s,
        completed: true,
      }));
      await qc.invalidateQueries({ queryKey: qk.setupStatus });
    },
  });
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function useGithubStatus(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.githubStatus,
    queryFn: async () => {
      const raw = await api.get<GithubStatus>('/api/github/status');
      return {
        ...raw,
        installations: asList<GithubStatus['installations'][number]>(raw.installations),
      };
    },
    enabled: opts.enabled ?? true,
  });
}

export function useCreateManifest() {
  return useMutation({
    mutationFn: (v: ManifestRequest) => api.post<ManifestResponse>('/api/github/manifest', v),
  });
}

export function useSyncInstallations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>('/api/github/sync-installations'),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.githubStatus }),
        qc.invalidateQueries({ queryKey: qk.githubRepos }),
        qc.invalidateQueries({ queryKey: qk.repositories }),
      ]);
    },
  });
}

export function useAvailableRepositories(enabled = true) {
  return useQuery({
    queryKey: qk.githubRepos,
    queryFn: async () =>
      asList<AvailableRepository>(await api.get('/api/github/repositories'), 'repositories'),
    enabled,
  });
}

export function useDisconnectGithub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<unknown>('/api/github/app'),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.githubStatus }),
  });
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export function useRepositories() {
  return useQuery({
    queryKey: qk.repositories,
    queryFn: async () => asList<Repository>(await api.get('/api/repositories'), 'repositories'),
  });
}

export function useRepository(id: string | undefined) {
  return useQuery({
    queryKey: qk.repository(id ?? ''),
    queryFn: async () => {
      const raw = await api.get<
        RepositoryDetail | { repository: Repository; profile: RepositoryDetail['profile'] }
      >(`/api/repositories/${encodeURIComponent(id ?? '')}`);
      if ('repository' in raw && raw.repository)
        return { ...raw.repository, profile: raw.profile ?? null };
      return raw as RepositoryDetail;
    },
    enabled: Boolean(id),
  });
}

export function useRepositoryOverview(id: string | undefined) {
  return useQuery({
    queryKey: qk.repositoryOverview(id ?? ''),
    queryFn: () =>
      api.get<RepositoryOverview>(`/api/repositories/${encodeURIComponent(id ?? '')}/overview`),
    enabled: Boolean(id),
  });
}

export function useUpdateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RepositoryPatch }) =>
      api.patch<Repository>(`/api/repositories/${encodeURIComponent(id)}`, patch),
    onSuccess: async (_d, v) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.repositories }),
        qc.invalidateQueries({ queryKey: qk.repository(v.id) }),
      ]);
    },
  });
}

export function useRediscoverRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<unknown>(`/api/repositories/${encodeURIComponent(id)}/rediscover`),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: qk.repository(id) }),
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function useProjects() {
  return useQuery({
    queryKey: qk.projects,
    queryFn: async () => asList<Project>(await api.get('/api/projects'), 'projects'),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: qk.project(id ?? ''),
    queryFn: async () => {
      const raw = await api.get<
        | ProjectDetail
        | { project: Project; repositories: Repository[]; members: ProjectDetail['members'] }
      >(`/api/projects/${encodeURIComponent(id ?? '')}`);
      const base = 'project' in raw && raw.project ? { ...raw.project } : (raw as ProjectDetail);
      return {
        ...base,
        repositories: asList<Repository>(raw.repositories),
        members: asList<ProjectDetail['members'][number]>(raw.members),
      } as ProjectDetail;
    },
    enabled: Boolean(id),
  });
}

export function useProjectOverview(id: string | undefined) {
  return useQuery({
    queryKey: qk.projectOverview(id ?? ''),
    queryFn: () =>
      api.get<ProjectOverview>(`/api/projects/${encodeURIComponent(id ?? '')}/overview`),
    enabled: Boolean(id),
  });
}

function useInvalidateProjects() {
  const qc = useQueryClient();
  return async (id?: string) => {
    await qc.invalidateQueries({ queryKey: qk.projects });
    if (id) await qc.invalidateQueries({ queryKey: qk.project(id) });
    await qc.invalidateQueries({ queryKey: qk.overview });
  };
}

export function useCreateProject() {
  const inv = useInvalidateProjects();
  return useMutation({
    mutationFn: async (v: ProjectCreate) => {
      const raw = await api.post<Project | { project: Project }>('/api/projects', v);
      return 'project' in raw ? raw.project : raw;
    },
    onSuccess: () => inv(),
  });
}

export function useUpdateProject() {
  const inv = useInvalidateProjects();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ProjectPatch }) =>
      api.patch<Project>(`/api/projects/${encodeURIComponent(id)}`, patch),
    onSuccess: (_d, v) => inv(v.id),
  });
}

export function useDeleteProject() {
  const inv = useInvalidateProjects();
  return useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/api/projects/${encodeURIComponent(id)}`),
    onSuccess: () => inv(),
  });
}

export function useSetProjectPaused() {
  const inv = useInvalidateProjects();
  return useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      api.post<unknown>(`/api/projects/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`),
    onSuccess: (_d, v) => inv(v.id),
  });
}

export function useProjectRepository() {
  const inv = useInvalidateProjects();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      repositoryId,
      remove,
    }: {
      projectId: string;
      repositoryId: string;
      remove?: boolean;
    }) =>
      remove
        ? api.delete<unknown>(`/api/projects/${encodeURIComponent(projectId)}/repositories`, {
            repositoryId,
          })
        : api.post<unknown>(`/api/projects/${encodeURIComponent(projectId)}/repositories`, {
            repositoryId,
          }),
    onSuccess: async (_d, v) => {
      await inv(v.projectId);
      await qc.invalidateQueries({ queryKey: qk.repositories });
    },
  });
}

export function useProjectMember() {
  const inv = useInvalidateProjects();
  return useMutation({
    mutationFn: ({
      projectId,
      userId,
      remove,
    }: {
      projectId: string;
      userId: string;
      remove?: boolean;
    }) =>
      remove
        ? api.delete<unknown>(`/api/projects/${encodeURIComponent(projectId)}/members`, { userId })
        : api.post<unknown>(`/api/projects/${encodeURIComponent(projectId)}/members`, { userId }),
    onSuccess: (_d, v) => inv(v.projectId),
  });
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export function usePullRequests(filters: PrListFilters, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.pullRequests(filters),
    queryFn: async () =>
      asList<PrListItem>(
        await api.get('/api/pull-requests', {
          projectId: filters.projectId,
          repositoryId: filters.repositoryId,
          state: filters.state,
          risk: filters.risk,
          author: filters.author,
        }),
        'pullRequests',
      ),
    enabled: opts.enabled ?? true,
  });
}

type RunSummary = Pick<
  NonNullable<PullRequestDetail['latestRun']>,
  'id' | 'status' | 'error' | 'startedAt' | 'createdAt' | 'headSha'
>;

/** The newest analysis run of a PR (which may differ from the run whose report is shown). */
export function currentRunOf(
  d: Pick<PullRequestDetail, 'analysis' | 'latestRun'> | undefined,
): RunSummary | null {
  return d?.latestRun ?? d?.analysis ?? null;
}

/** Identifies one run attempt (a forced re-run reuses the row but gets a new start time). */
export function runKey(run: RunSummary | null): string {
  return run ? `${run.id}:${run.startedAt ?? run.createdAt}` : '';
}

export interface AwaitRun {
  /** `runKey` of the newest run when the re-analysis was requested. */
  previousKey: string;
  requestedAt: number;
}

const AWAIT_RUN_TIMEOUT_MS = 10 * 60_000;

export function usePullRequest(
  id: string | undefined,
  opts: {
    /** Keep polling until a run newer than `previousKey` shows up (or the timeout passes). */
    awaitRun?: AwaitRun | null;
  } = {},
) {
  return useQuery({
    queryKey: qk.pullRequest(id ?? ''),
    queryFn: async () => {
      const raw = await api.get<PullRequestDetail>(
        `/api/pull-requests/${encodeURIComponent(id ?? '')}`,
      );
      return {
        ...raw,
        findings: asList<PullRequestDetail['findings'][number]>(raw.findings),
        relationships: asList<PullRequestDetail['relationships'][number]>(raw.relationships),
        checks: asList<PullRequestDetail['checks'][number]>(raw.checks),
        reviews: asList<PullRequestDetail['reviews'][number]>(raw.reviews),
      } satisfies PullRequestDetail;
    },
    enabled: Boolean(id),
    // Poll while an analysis is in flight.
    refetchInterval: (q) => {
      const run = currentRunOf(q.state.data);
      if (run?.status === 'queued' || run?.status === 'running') return 5000;
      const awaiting = opts.awaitRun;
      // A re-analysis was requested but no worker has picked it up yet.
      if (
        awaiting &&
        Date.now() - awaiting.requestedAt < AWAIT_RUN_TIMEOUT_MS &&
        runKey(run) === awaiting.previousKey
      )
        return 5000;
      return false;
    },
  });
}

export function useAnalyses(id: string | undefined) {
  return useQuery({
    queryKey: qk.analyses(id ?? ''),
    queryFn: async () =>
      asList<AnalysisHistoryItem>(
        await api.get(`/api/pull-requests/${encodeURIComponent(id ?? '')}/analyses`),
        'analyses',
      ),
    enabled: Boolean(id),
  });
}

export function useReanalyze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<unknown>(`/api/pull-requests/${encodeURIComponent(id)}/reanalyze`),
    onSuccess: async (_d, id) => {
      await qc.invalidateQueries({ queryKey: qk.pullRequest(id) });
      await qc.invalidateQueries({ queryKey: qk.analyses(id) });
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function useOverview(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.overview,
    queryFn: () => api.get<OverviewResponse>('/api/overview'),
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

export function useRiskCenter() {
  return useQuery({
    queryKey: qk.riskCenter,
    queryFn: async () => {
      const raw = await api.get<Partial<RiskCenterResponse> & { prs?: PrListItem[] }>(
        '/api/risk-center',
      );
      return {
        pullRequests: asList<PrListItem>(raw.pullRequests ?? raw.prs),
        findings: asList<RiskCenterResponse['findings'][number]>(raw.findings),
        relationships: asList<RiskCenterResponse['relationships'][number]>(raw.relationships),
      } satisfies RiskCenterResponse;
    },
  });
}

export function useDevelopers() {
  return useQuery({
    queryKey: qk.developers,
    queryFn: async () => asList<Developer>(await api.get('/api/developers'), 'developers'),
  });
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export function useAiSettings(enabled = true) {
  return useQuery({
    queryKey: qk.aiSettings,
    queryFn: () => api.get<AiSettings>('/api/settings/ai'),
    enabled,
  });
}

export function useUpdateAiSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: AiSettingsUpdate) => api.put<AiSettings>('/api/settings/ai', v),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.aiSettings });
      await qc.invalidateQueries({ queryKey: qk.overview });
    },
  });
}

export function useAiProviders(enabled = true) {
  return useQuery({
    queryKey: qk.aiProviders,
    queryFn: async () =>
      asList<AiProvider>(await api.get('/api/settings/ai/providers'), 'providers'),
    enabled,
  });
}

export function useCreateAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: AiProviderCreate) => {
      const raw = await api.post<AiProvider | { provider: AiProvider }>(
        '/api/settings/ai/providers',
        v,
      );
      return 'provider' in raw ? raw.provider : raw;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.aiProviders }),
  });
}

export function useDeleteAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<unknown>(`/api/settings/ai/providers/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.aiProviders }),
  });
}

export function useTestAiProvider() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<TestResult>(`/api/settings/ai/providers/${encodeURIComponent(id)}/test`),
  });
}

export function useUsage(enabled = true) {
  return useQuery({
    queryKey: qk.usage,
    queryFn: () => api.get<UsageResponse>('/api/usage'),
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const CH = '/api/settings/notification-channels';
const RULES = '/api/settings/notification-rules';

export function useChannels(enabled = true) {
  return useQuery({
    queryKey: qk.channels,
    queryFn: async () => asList<NotificationChannel>(await api.get(CH), 'channels'),
    enabled,
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NotificationChannelCreate) => api.post<NotificationChannel>(CH, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useUpdateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<NotificationChannelCreate> }) =>
      api.patch<NotificationChannel>(`${CH}/${encodeURIComponent(id)}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`${CH}/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useTestChannel() {
  return useMutation({
    mutationFn: (id: string) => api.post<TestResult>(`${CH}/${encodeURIComponent(id)}/test`),
  });
}

export function useRules(enabled = true) {
  return useQuery({
    queryKey: qk.rules,
    queryFn: async () => asList<NotificationRule>(await api.get(RULES), 'rules'),
    enabled,
  });
}

export function useSaveRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, rule }: { id?: string; rule: NotificationRuleInput }) =>
      id
        ? api.patch<NotificationRule>(`${RULES}/${encodeURIComponent(id)}`, rule)
        : api.post<NotificationRule>(RULES, rule),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.rules }),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`${RULES}/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.rules }),
  });
}

export function useNotifications(unreadOnly = false) {
  return useQuery({
    queryKey: qk.notifications(unreadOnly),
    queryFn: async () =>
      asList<NotificationItem>(
        await api.get('/api/notifications', unreadOnly ? { unread: true } : undefined),
        'notifications',
      ),
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<unknown>(`/api/notifications/${encodeURIComponent(id)}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] as QueryKey }),
  });
}

// ---------------------------------------------------------------------------
// Users, system, audit
// ---------------------------------------------------------------------------

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: qk.users,
    queryFn: async () => {
      const raw = await api.get<UsersResponse | OrgUser[]>('/api/users');
      if (Array.isArray(raw)) return { users: raw, invites: [] as InviteItem[] };
      return { users: asList<OrgUser>(raw.users), invites: asList<InviteItem>(raw.invites) };
    },
    enabled,
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: InviteRequest) => api.post<InviteResponse>('/api/users/invite', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { role?: OrgUser['role']; disabled?: boolean };
    }) => api.patch<OrgUser>(`/api/users/${encodeURIComponent(id)}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: qk.systemStatus,
    queryFn: () => api.get<SystemStatus>('/api/system/status'),
    refetchInterval: 30_000,
  });
}

export function useAuditLog(cursor: string | null) {
  return useQuery({
    queryKey: qk.auditLog(cursor),
    queryFn: async () => {
      const raw = await api.get<AuditLogResponse | AuditLogEntry[]>('/api/audit-log', {
        limit: 50,
        before: cursor ?? undefined,
      });
      if (Array.isArray(raw)) return { entries: raw, nextCursor: null };
      return { entries: asList<AuditLogEntry>(raw.entries), nextCursor: raw.nextCursor ?? null };
    },
  });
}
