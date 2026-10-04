-- Run this in Supabase Dashboard > SQL Editor.
create table if not exists public.group_data (
    key text primary key,
    value jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
);

alter table public.group_data enable row level security;
revoke all on public.group_data from anon;
grant select, insert, update on public.group_data to authenticated;

-- All signed-in study group members share these records.
create policy "Signed-in members can read group data"
    on public.group_data for select to authenticated using (true);

create policy "Signed-in members can add group data"
    on public.group_data for insert to authenticated with check (true);

create policy "Signed-in members can update group data"
    on public.group_data for update to authenticated using (true) with check (true);

-- Realtime is optional; the app also refreshes cloud data periodically.
alter publication supabase_realtime add table public.group_data;
