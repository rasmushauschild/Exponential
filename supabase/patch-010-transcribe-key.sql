-- Optional cloud transcription (AssemblyAI): one team-level API key. Additive; old
-- clients select explicit columns and never see it.
alter table public.teams add column if not exists transcribe_key text;
