import { FolderKanban, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client.ts';
import { useCreateProject, useIsAdmin, useProjects, useRepositories } from '../api/hooks.ts';
import { RiskCountsBar } from '../components/PrTable.tsx';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Textarea,
} from '../components/ui.tsx';
import { RepoSelector } from '../features/repos.tsx';

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const repos = useRepositories();
  const create = useCreateProject();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name: name.trim(), description: description.trim() || null, repositoryIds: [...selected] },
      {
        onSuccess: (p) => {
          onClose();
          if (p?.id) navigate(`/projects/${p.id}`);
        },
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Description" optional>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        {repos.data && repos.data.length > 0 && (
          <RepoSelector repos={repos.data} selected={selected} onChange={setSelected} />
        )}
        {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectsPage() {
  const projects = useProjects();
  const isAdmin = useIsAdmin();
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Each project groups the repositories that make up one product or team."
        actions={
          isAdmin && (
            <Button
              onClick={() => setCreating(true)}
              icon={<Plus className="size-4" aria-hidden />}
            >
              New project
            </Button>
          )
        }
      />
      {projects.isPending ? (
        <LoadingBlock />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
      ) : projects.data.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          action={
            isAdmin ? (
              <Button onClick={() => setCreating(true)}>Create your first project</Button>
            ) : undefined
          }
        >
          {isAdmin
            ? 'Create a project and add repositories to start receiving pull request reports.'
            : 'You have not been added to any project yet. Ask an admin to add you.'}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data.map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className="block h-full rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-400 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold break-words">{p.name}</h2>
                  {p.paused && <Badge tone="amber">Paused</Badge>}
                </div>
                {p.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">
                    {p.description}
                  </p>
                )}
                <div className="mt-3 text-xs text-slate-600 dark:text-slate-400">
                  {p.openPrCount ?? 0} open PRs · {p.repositoryCount ?? 0} repositories ·{' '}
                  {p.memberCount ?? 0} members
                </div>
                {p.riskCounts && (
                  <div className="mt-3">
                    <RiskCountsBar counts={p.riskCounts} />
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}
