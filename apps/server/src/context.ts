import type { AiProvider, ProviderConfig } from '@gmp/ai';
import type { Config, Logger, UserRole } from '@gmp/core';
import type { Database } from '@gmp/db';
import type {
  GitHubClient,
  GitHubAppCredentials,
  ManifestConversion,
  ConvertManifestCodeOptions,
} from '@gmp/github';
import type { TestChannelOptions } from '@gmp/notify';
import type { JobQueue } from './queue.ts';
import type { AccessScope } from './access.ts';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: UserRole;
  timezone: string | null;
}

export interface AuthSession {
  id: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface AuthContext {
  user: AuthUser;
  session: AuthSession;
}

/** External integrations that tests replace with fakes. */
export interface GitHubDeps {
  convertManifestCode(
    code: string,
    options: ConvertManifestCodeOptions,
  ): Promise<ManifestConversion>;
  createClient(creds: GitHubAppCredentials): GitHubClient;
}

export interface ServerContext {
  config: Config;
  db: Database;
  queue: JobQueue;
  logger: Logger;
  github: GitHubDeps;
  aiProviderFactory: (cfg: ProviderConfig & { providerId: string }) => AiProvider;
  notifyTestOptions: TestChannelOptions;
  now: () => Date;
  version: string;
  sessionTtlMs: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: ServerContext;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
    accessScope: Promise<AccessScope> | null;
  }
  interface FastifyContextConfig {
    /** Route does not require a session-bound CSRF header even when a session exists. */
    csrfExempt?: boolean;
    /** Route accepts non-JSON bodies (webhook). */
    rawBody?: boolean;
  }
}
