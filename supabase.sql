-- À coller dans Supabase > SQL Editor, puis « Run ». Une seule fois.

create extension if not exists pgcrypto;

create table if not exists boards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text not null default '✨',
  color text not null default '#E3D3F7',
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('link', 'image', 'text')),
  url text,
  text text,
  title text,
  note text,
  site text,
  price text,
  image_url text,
  image_path text,
  board_id uuid references boards(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists items_created_idx on items (created_at desc);
create index if not exists items_board_idx on items (board_id);

-- Sécurité : RLS activé et aucune règle publique.
-- Seul le serveur Vercel (clé secrète) peut lire et écrire.
alter table boards enable row level security;
alter table items enable row level security;

insert into boards (name, emoji, color, position)
select * from (values
  ('Mode', '👗', '#F4C6D7', 0),
  ('Food', '🍝', '#FFB38A', 1),
  ('Reading', '📚', '#B9D8C2', 2),
  ('Quotes', '💬', '#C9CCF5', 3),
  ('Fitness', '💪', '#D9F07A', 4),
  ('Spiritual', '🕊️', '#E3D3F7', 5),
  ('Voyage', '✈️', '#A9DDF2', 6),
  ('Déco', '🪴', '#F2DFA7', 7)
) as v(name, emoji, color, position)
where not exists (select 1 from boards);

-- Espace de stockage des images (lecture publique par lien, écriture réservée au serveur)
insert into storage.buckets (id, name, public)
values ('glane', 'glane', true)
on conflict (id) do nothing;
