-- Tasks can come from a project's to-do list or be subtasks of another task.
alter table public.tasks add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.tasks add column if not exists parent_id uuid references public.tasks(id) on delete set null;
create index if not exists tasks_project on public.tasks(project_id);
create index if not exists tasks_parent on public.tasks(parent_id);
