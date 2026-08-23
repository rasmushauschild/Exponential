-- Project/subtask backlogs hold tasks nobody has taken yet.
alter table public.tasks alter column person_id drop not null;
