-- ============================================================================
--  Safekey — database schema
--  Run this once in Supabase → SQL Editor. It is idempotent: running it again
--  is safe.
--
--  Every database primary key is a 32-bit integer identity column.
--  Authentication is owned by Supabase Auth (email/password + Google). The
--  `users.supabase_user_id` column stores that external identity as text
--  (Supabase Auth uses UUIDs internally) and links it to Safekey's integer ID.
-- ============================================================================

-- Older builds of Safekey used UUID primary keys. Refuse to silently leave
-- those tables in place, because `create table if not exists` cannot change
-- column types. Recreate the database (or migrate the IDs manually) first.
do $$
declare
  uuid_tables text;
begin
  select string_agg(table_name, ', ' order by table_name)
    into uuid_tables
    from information_schema.columns
   where table_schema = 'public'
     and column_name = 'id'
     and data_type = 'uuid'
     and table_name in (
       'users',
       'password_reset_tokens',
       'folders',
       'folder_columns',
       'folder_items',
       'item_values'
     );

  if uuid_tables is not null then
    raise exception using
      message = 'This database uses the old UUID schema (' || uuid_tables || '). Safekey now requires integer IDs.',
      hint = 'Back up the data, recreate the database, then run db/schema.sql again.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
--  Users
-- ---------------------------------------------------------------------------
create table if not exists users (
  id                integer generated always as identity primary key,
  email             text not null,
  full_name         text,
  supabase_user_id  text,
  has_password      boolean not null default false,
  has_google        boolean not null default false,
  status            text not null default 'active'
                      check (status in ('active', 'inactive', 'archived')),
  archived_at       timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Upgrade databases created before Supabase owned authentication. Existing
-- password hashes are removed: credentials now live in Supabase Auth and are
-- never stored by Safekey. These statements are safe to re-run.
alter table users add column if not exists has_password boolean not null default false;
alter table users add column if not exists has_google boolean not null default false;
alter table users add column if not exists status text not null default 'active';
alter table users add column if not exists archived_at timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'users_identity_check') then
    alter table users drop constraint users_identity_check;
  end if;
end;
$$;

alter table users drop column if exists password_hash;
alter table users drop column if exists token_version;

-- Avatars are generated from initials, and identities live in
-- `supabase_user_id`. Drop legacy columns from intermediate builds.
alter table users drop column if exists avatar_url;
alter table users drop column if exists google_id;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'users_status_check') then
    alter table users drop constraint users_status_check;
  end if;

  alter table users
    add constraint users_status_check
    check (status in ('active', 'inactive', 'archived'));
end;
$$;

create unique index if not exists users_email_unique on users (lower(email));
create unique index if not exists users_supabase_user_unique
  on users (supabase_user_id)
  where supabase_user_id is not null;

-- ---------------------------------------------------------------------------
--  Supabase Auth owns password resets
-- ---------------------------------------------------------------------------
-- Earlier builds stored their own reset tokens. Supabase now emails recovery
-- links and the browser updates the password through Supabase directly.
drop table if exists password_reset_tokens;

-- ---------------------------------------------------------------------------
--  Vaults ("folders") — one per site/topic, owned by a user
-- ---------------------------------------------------------------------------
create table if not exists folders (
  id          integer generated always as identity primary key,
  user_id     integer not null references users(id) on delete cascade,
  name        text not null,
  description text,
  color       text not null default 'olive',
  icon        text not null default 'folder',
  status      text not null default 'active'
                check (status in ('active', 'archived', 'failed')),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint folders_name_length check (char_length(name) between 1 and 60)
);

-- Existing databases: add the folder lifecycle columns and constraint.
alter table folders add column if not exists status text not null default 'active';
alter table folders add column if not exists archived_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'folders_status_check') then
    alter table folders
      add constraint folders_status_check
      check (status in ('active', 'archived', 'failed'));
  end if;
end;
$$;

-- Only active vaults reserve their name. Archived/failed vaults keep their row
-- for history without blocking a fresh vault with the same name.
drop index if exists folders_user_name_unique;
create unique index if not exists folders_user_name_unique
  on folders (user_id, lower(name))
  where status = 'active';
create index if not exists folders_user_idx on folders (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
--  Custom columns — each vault defines its own fields
-- ---------------------------------------------------------------------------
create table if not exists folder_columns (
  id          integer generated always as identity primary key,
  folder_id   integer not null references folders(id) on delete cascade,
  name        text not null,
  type        text not null default 'text'
                check (type in ('text', 'password', 'email', 'username', 'url', 'note', 'number', 'date')),
  is_secret   boolean not null default false,
  is_required boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint folder_columns_password_is_secret check (type <> 'password' or is_secret),
  constraint folder_columns_name_length check (char_length(name) between 1 and 40)
);

create unique index if not exists folder_columns_folder_name_unique
  on folder_columns (folder_id, lower(name));
create index if not exists folder_columns_folder_idx on folder_columns (folder_id, position);

-- ---------------------------------------------------------------------------
--  Entries ("items") inside a vault
-- ---------------------------------------------------------------------------
create table if not exists folder_items (
  id          integer generated by default as identity primary key,
  folder_id   integer not null references folders(id) on delete cascade,
  user_id     integer not null references users(id) on delete cascade,
  title       text not null,
  notes       text,
  status      text not null default 'active'
                check (status in ('active', 'archived')),
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint folder_items_title_length check (char_length(title) between 1 and 120)
);

-- Deleting an entry archives it instead of removing the row. These statements
-- also upgrade databases created before archiving existed.
alter table folder_items add column if not exists status text not null default 'active';
alter table folder_items add column if not exists archived_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'folder_items_status_check'
  ) then
    alter table folder_items
      add constraint folder_items_status_check
      check (status in ('active', 'archived'));
  end if;
end;
$$;

create index if not exists folder_items_folder_idx on folder_items (folder_id, created_at desc);
create index if not exists folder_items_active_idx
  on folder_items (folder_id, status, created_at desc);
create index if not exists folder_items_user_idx on folder_items (user_id);

-- Item IDs are reserved before their encrypted values are written, so the
-- identity column must accept an explicitly supplied value.
alter table folder_items alter column id set generated by default;

-- ---------------------------------------------------------------------------
--  Entry values — one row per entry/column pair.
--  Secret columns store AES-256-GCM ciphertext, everything else plaintext.
-- ---------------------------------------------------------------------------
create table if not exists item_values (
  id         integer generated always as identity primary key,
  item_id    integer not null references folder_items(id) on delete cascade,
  column_id  integer not null references folder_columns(id) on delete cascade,
  value      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, column_id)
);

create index if not exists item_values_item_idx on item_values (item_id);
create index if not exists item_values_column_idx on item_values (column_id);

-- ---------------------------------------------------------------------------
--  Keep updated_at columns fresh
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on users;
create trigger users_touch_updated_at
  before update on users
  for each row execute function touch_updated_at();

drop trigger if exists folders_touch_updated_at on folders;
create trigger folders_touch_updated_at
  before update on folders
  for each row execute function touch_updated_at();

drop trigger if exists folder_columns_touch_updated_at on folder_columns;
create trigger folder_columns_touch_updated_at
  before update on folder_columns
  for each row execute function touch_updated_at();

drop trigger if exists folder_items_touch_updated_at on folder_items;
create trigger folder_items_touch_updated_at
  before update on folder_items
  for each row execute function touch_updated_at();

drop trigger if exists item_values_touch_updated_at on item_values;
create trigger item_values_touch_updated_at
  before update on item_values
  for each row execute function touch_updated_at();

-- ============================================================================
--  Supabase access model
--
--  Safekey never connects to Postgres directly. The API talks to Supabase with
--  the service-role key, which bypasses RLS. RLS is still enabled so the public
--  anon/authenticated keys cannot read or write these tables on their own.
-- ============================================================================
alter table users enable row level security;
alter table folders enable row level security;
alter table folder_columns enable row level security;
alter table folder_items enable row level security;
alter table item_values enable row level security;

-- ============================================================================
--  API RPC functions
--
--  These are the only database operations the API calls. Each one is scoped by
--  the Safekey integer user ID and runs as the schema owner (security definer),
--  while execute permission is granted to `service_role` only.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Users
-- ---------------------------------------------------------------------------
create or replace function api_user_json(u users)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', u.id,
    'supabase_user_id', u.supabase_user_id,
    'email', u.email,
    'full_name', u.full_name,
    'has_password', u.has_password,
    'has_google', u.has_google,
    'status', u.status,
    'created_at', u.created_at
  );
$$;

create or replace function api_resolve_user(
  p_supabase_user_id text,
  p_email text,
  p_full_name text,
  p_has_password boolean,
  p_has_google boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user users;
  v_existing users;
begin
  select * into v_user
    from users
   where supabase_user_id = p_supabase_user_id;

  if found then
    update users
       set last_login_at = now(),
           status = case when status = 'archived' then 'archived' else 'active' end,
           full_name = coalesce(full_name, p_full_name),
           has_password = has_password or p_has_password,
           has_google = has_google or p_has_google
     where id = v_user.id
     returning * into v_user;

    return api_user_json(v_user);
  end if;

  select * into v_existing
    from users
   where lower(email) = lower(p_email)
   limit 1;

  if found then
    -- Never silently replace an existing sign-in identity with a different one.
    if v_existing.supabase_user_id is not null
       and v_existing.supabase_user_id <> p_supabase_user_id then
      raise exception 'IDENTITY_CONFLICT' using errcode = 'P0001';
    end if;

    begin
      update users
         set supabase_user_id = p_supabase_user_id,
             status = case when status = 'archived' then 'archived' else 'active' end,
             full_name = coalesce(full_name, p_full_name),
             has_password = has_password or p_has_password,
             has_google = has_google or p_has_google,
             last_login_at = now()
       where id = v_existing.id
       returning * into v_user;

      return api_user_json(v_user);
    exception when unique_violation then
      select * into v_user from users where supabase_user_id = p_supabase_user_id;
      if found then return api_user_json(v_user); end if;
      raise exception 'IDENTITY_CONFLICT' using errcode = 'P0001';
    end;
  end if;

  begin
    insert into users (email, supabase_user_id, full_name, has_password, has_google, last_login_at)
    values (p_email, p_supabase_user_id, p_full_name, p_has_password, p_has_google, now())
    returning * into v_user;

    return api_user_json(v_user);
  exception when unique_violation then
    -- A concurrent first request may have created the same identity.
    select * into v_user from users where supabase_user_id = p_supabase_user_id;
    if found then return api_user_json(v_user); end if;
    raise exception 'ACCOUNT_CONFLICT' using errcode = 'P0001';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
--  Vaults
-- ---------------------------------------------------------------------------
create or replace function api_column_json(c folder_columns)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'type', c.type,
    'isSecret', c.is_secret,
    'isRequired', c.is_required,
    'position', c.position
  );
$$;

create or replace function api_folder_json(p_folder_id integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'description', f.description,
    'color', f.color,
    'icon', f.icon,
    'status', f.status,
    'archivedAt', f.archived_at,
    'createdAt', f.created_at,
    'updatedAt', f.updated_at,
    'itemCount', (
      select count(*)::integer
        from folder_items i
       where i.folder_id = f.id
         and i.status = 'active'
    ),
    'columnNames', coalesce(
      (
        select jsonb_agg(c.name order by c.position, c.created_at)
          from folder_columns c
         where c.folder_id = f.id
      ),
      '[]'::jsonb
    )
  )
  from folders f
  where f.id = p_folder_id;
$$;

create or replace function api_list_folders(p_user_id integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(api_folder_json(f.id) order by f.updated_at desc),
    '[]'::jsonb
  )
  from folders f
  where f.user_id = p_user_id
    and f.status = 'active';
$$;

create or replace function api_get_folder(p_user_id integer, p_folder_id integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'description', f.description,
    'color', f.color,
    'icon', f.icon,
    'status', f.status,
    'archivedAt', f.archived_at,
    'createdAt', f.created_at,
    'updatedAt', f.updated_at,
    'itemCount', (
      select count(*)::integer
        from folder_items i
       where i.folder_id = f.id
         and i.status = 'active'
    ),
    'columnNames', coalesce(
      (
        select jsonb_agg(c.name order by c.position, c.created_at)
          from folder_columns c
         where c.folder_id = f.id
      ),
      '[]'::jsonb
    ),
    'columns', coalesce(
      (
        select jsonb_agg(api_column_json(c) order by c.position, c.created_at)
          from folder_columns c
         where c.folder_id = f.id
      ),
      '[]'::jsonb
    )
  )
  from folders f
  where f.id = p_folder_id
    and f.user_id = p_user_id
    and f.status = 'active';
$$;

-- Return type changed from integer to jsonb; drop the old function first so
-- `create or replace` works on databases that already ran the previous schema.
drop function if exists api_create_folder(integer, text, text, text, text, jsonb);

create or replace function api_create_folder(
  p_user_id integer,
  p_name text,
  p_description text,
  p_color text,
  p_icon text,
  p_columns jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_folder_id integer;
  v_column jsonb;
  v_position integer := 0;
begin
  -- Start as `failed`. Only flip to `active` after every template column has
  -- been written, so an interrupted/failed creation stays visible in the table.
  insert into folders (user_id, name, description, color, icon, status)
  values (p_user_id, p_name, p_description, p_color, p_icon, 'failed')
  returning id into v_folder_id;

  begin
    for v_column in select * from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb))
    loop
      insert into folder_columns (folder_id, name, type, is_secret, is_required, position)
      values (
        v_folder_id,
        v_column->>'name',
        coalesce(v_column->>'type', 'text'),
        coalesce((v_column->>'isSecret')::boolean, coalesce(v_column->>'type', '') = 'password'),
        coalesce((v_column->>'isRequired')::boolean, false),
        v_position
      );

      v_position := v_position + 1;
    end loop;
  exception when others then
    update folders
       set status = 'failed',
           updated_at = now()
     where id = v_folder_id;

    return jsonb_build_object(
      'id', v_folder_id,
      'status', 'failed',
      'error', sqlerrm
    );
  end;

  update folders
     set status = 'active',
         updated_at = now()
   where id = v_folder_id;

  return jsonb_build_object('id', v_folder_id, 'status', 'active');
end;
$$;

-- ---------------------------------------------------------------------------
--  Columns
-- ---------------------------------------------------------------------------
create or replace function api_create_column(
  p_user_id integer,
  p_folder_id integer,
  p_name text,
  p_type text,
  p_is_secret boolean,
  p_is_required boolean,
  p_max_columns integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_column folder_columns;
  v_count integer;
  v_position integer;
begin
  if not exists (
    select 1 from folders
     where id = p_folder_id
       and user_id = p_user_id
       and status = 'active'
  ) then
    return null;
  end if;

  select count(*), coalesce(max(position), -1) + 1
    into v_count, v_position
    from folder_columns
   where folder_id = p_folder_id;

  if v_count >= coalesce(p_max_columns, 20) then
    raise exception 'COLUMN_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  insert into folder_columns (folder_id, name, type, is_secret, is_required, position)
  values (p_folder_id, p_name, p_type, p_is_secret, p_is_required, v_position)
  returning * into v_column;

  update folders set updated_at = now() where id = p_folder_id;

  return api_column_json(v_column);
end;
$$;

create or replace function api_get_column(p_user_id integer, p_column_id integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select api_column_json(c) || jsonb_build_object('folderId', c.folder_id)
    from folder_columns c
    join folders f on f.id = c.folder_id
   where c.id = p_column_id
     and f.user_id = p_user_id
     and f.status = 'active';
$$;

create or replace function api_column_values(p_user_id integer, p_column_id integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', v.id, 'value', v.value, 'itemId', v.item_id)
      order by v.id
    ),
    '[]'::jsonb
  )
  from item_values v
  join folder_items i on i.id = v.item_id
  where v.column_id = p_column_id
    and i.user_id = p_user_id;
$$;

create or replace function api_update_column(
  p_user_id integer,
  p_column_id integer,
  p_name text,
  p_type text,
  p_is_secret boolean,
  p_is_required boolean,
  p_value_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_folder_id integer;
  v_column folder_columns;
  v_update jsonb;
begin
  select c.folder_id
    into v_folder_id
    from folder_columns c
    join folders f on f.id = c.folder_id
   where c.id = p_column_id
     and f.user_id = p_user_id
     and f.status = 'active';

  if v_folder_id is null then
    return null;
  end if;

  update folder_columns
     set name = coalesce(p_name, name),
         type = p_type,
         is_secret = p_is_secret,
         is_required = p_is_required
   where id = p_column_id
   returning * into v_column;

  -- Prepared in Node so AES-256-GCM encryption never leaves the API process.
  for v_update in select * from jsonb_array_elements(coalesce(p_value_updates, '[]'::jsonb))
  loop
    update item_values
       set value = v_update->>'value',
           updated_at = now()
     where id = (v_update->>'id')::integer
       and column_id = p_column_id;
  end loop;

  update folders set updated_at = now() where id = v_folder_id;

  return api_column_json(v_column);
end;
$$;

create or replace function api_delete_column(p_user_id integer, p_column_id integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_folder_id integer;
begin
  select c.folder_id
    into v_folder_id
    from folder_columns c
    join folders f on f.id = c.folder_id
   where c.id = p_column_id
     and f.user_id = p_user_id
     and f.status = 'active';

  if v_folder_id is null then
    return null;
  end if;

  delete from folder_columns where id = p_column_id;
  update folders set updated_at = now() where id = v_folder_id;

  return v_folder_id;
end;
$$;

create or replace function api_reorder_columns(
  p_user_id integer,
  p_folder_id integer,
  p_ids integer[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_index integer;
  v_total integer;
begin
  if not exists (
    select 1 from folders
     where id = p_folder_id
       and user_id = p_user_id
       and status = 'active'
  ) then
    return null;
  end if;

  select count(*) into v_total from folder_columns where folder_id = p_folder_id;

  if v_total <> coalesce(array_length(p_ids, 1), 0)
     or exists (
       select 1
         from unnest(p_ids) as u(id)
        where not exists (
          select 1 from folder_columns c where c.folder_id = p_folder_id and c.id = u.id
        )
     ) then
    raise exception 'COLUMN_ORDER_STALE' using errcode = 'P0001';
  end if;

  for v_index in 1..coalesce(array_length(p_ids, 1), 0)
  loop
    update folder_columns
       set position = v_index - 1
     where id = p_ids[v_index]
       and folder_id = p_folder_id;
  end loop;

  update folders set updated_at = now() where id = p_folder_id;

  return coalesce(
    (
      select jsonb_agg(api_column_json(c) order by c.position, c.created_at)
        from folder_columns c
       where c.folder_id = p_folder_id
    ),
    '[]'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
--  Entries
-- ---------------------------------------------------------------------------
create or replace function api_reserve_item_id()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select nextval(pg_get_serial_sequence('folder_items', 'id'))::integer;
$$;

create or replace function api_item_json(i folder_items)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', i.id,
    'title', i.title,
    'notes', i.notes,
    'createdAt', i.created_at,
    'updatedAt', i.updated_at,
    'values', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'columnId', v.column_id,
            'value', case when c.is_secret then null else v.value end,
            'hasValue', coalesce(v.value, '') <> ''
          )
          order by c.position, c.created_at
        )
        from item_values v
        join folder_columns c on c.id = v.column_id
        where v.item_id = i.id
      ),
      '[]'::jsonb
    )
  );
$$;

create or replace function api_get_item(p_user_id integer, p_item_id integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select api_item_json(i) || jsonb_build_object('folderId', f.id, 'folderName', f.name)
    from folder_items i
    join folders f on f.id = i.folder_id
   where i.id = p_item_id
     and i.user_id = p_user_id
     and i.status = 'active'
     and f.status = 'active';
$$;

create or replace function api_list_items(
  p_user_id integer,
  p_folder_id integer,
  p_search text,
  p_pattern text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from folders
     where id = p_folder_id
       and user_id = p_user_id
       and status = 'active'
  ) then
    return null;
  end if;

  return (
    select coalesce(
      jsonb_agg(api_item_json(i) order by i.created_at desc),
      '[]'::jsonb
    )
    from (
      select *
        from folder_items i
       where i.folder_id = p_folder_id
         and i.user_id = p_user_id
         and i.status = 'active'
         and (
           coalesce(p_search, '') = ''
           or i.title ilike p_pattern escape '\'
           or exists (
             select 1
               from item_values sv
               join folder_columns sc on sc.id = sv.column_id
              where sv.item_id = i.id
                and sc.is_secret = false
                and sv.value ilike p_pattern escape '\'
           )
         )
       order by i.created_at desc
       limit p_limit
    ) i
  );
end;
$$;

/**
 * Search every active entry the user owns, across all active vaults. Secret
 * values are never searched or returned; only title, notes and visible values.
 */
create or replace function api_search_items(
  p_user_id integer,
  p_pattern text,
  p_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(result.item order by result.updated_at desc),
    '[]'::jsonb
  )
  from (
    select
      jsonb_build_object(
        'id', i.id,
        'title', i.title,
        'notes', i.notes,
        'folderId', f.id,
        'folderName', f.name,
        'folderColor', f.color,
        'folderIcon', f.icon,
        'updatedAt', i.updated_at,
        'matchedField', (
          select c.name
            from item_values v
            join folder_columns c on c.id = v.column_id
           where v.item_id = i.id
             and c.is_secret = false
             and v.value ilike p_pattern escape '\'
           order by c.position, c.created_at
           limit 1
        )
      ) as item,
      i.updated_at
    from folder_items i
    join folders f on f.id = i.folder_id
   where i.user_id = p_user_id
     and i.status = 'active'
     and f.status = 'active'
     and (
       i.title ilike p_pattern escape '\'
       or coalesce(i.notes, '') ilike p_pattern escape '\'
       or exists (
         select 1
           from item_values sv
           join folder_columns sc on sc.id = sv.column_id
          where sv.item_id = i.id
            and sc.is_secret = false
            and sv.value ilike p_pattern escape '\'
       )
     )
   order by i.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 100))
  ) result;
$$;

create or replace function api_create_item(
  p_user_id integer,
  p_folder_id integer,
  p_item_id integer,
  p_title text,
  p_notes text,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item folder_items;
  v_value jsonb;
begin
  if not exists (
    select 1 from folders
     where id = p_folder_id
       and user_id = p_user_id
       and status = 'active'
  ) then
    return null;
  end if;

  insert into folder_items (id, folder_id, user_id, title, notes)
  values (p_item_id, p_folder_id, p_user_id, p_title, p_notes)
  returning * into v_item;

  for v_value in select * from jsonb_array_elements(coalesce(p_values, '[]'::jsonb))
  loop
    insert into item_values (item_id, column_id, value)
    values (p_item_id, (v_value->>'columnId')::integer, v_value->>'value')
    on conflict (item_id, column_id)
    do update set value = excluded.value, updated_at = now();
  end loop;

  update folders set updated_at = now() where id = p_folder_id;

  return api_item_json(v_item) || jsonb_build_object(
    'folderId', p_folder_id,
    'folderName', (select name from folders where id = p_folder_id)
  );
end;
$$;

create or replace function api_update_item(
  p_user_id integer,
  p_item_id integer,
  p_update_title boolean,
  p_title text,
  p_update_notes boolean,
  p_notes text,
  p_values jsonb,
  p_clear_column_ids integer[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item folder_items;
  v_value jsonb;
begin
  select i.* into v_item
    from folder_items i
    join folders f on f.id = i.folder_id
   where i.id = p_item_id
     and i.user_id = p_user_id
     and i.status = 'active'
     and f.status = 'active';

  if not found then
    return null;
  end if;

  update folder_items
     set title = case when p_update_title then p_title else title end,
         notes = case when p_update_notes then p_notes else notes end
   where id = p_item_id
   returning * into v_item;

  if p_clear_column_ids is not null then
    delete from item_values
     where item_id = p_item_id
       and column_id = any(p_clear_column_ids);
  end if;

  for v_value in select * from jsonb_array_elements(coalesce(p_values, '[]'::jsonb))
  loop
    insert into item_values (item_id, column_id, value)
    values (p_item_id, (v_value->>'columnId')::integer, v_value->>'value')
    on conflict (item_id, column_id)
    do update set value = excluded.value, updated_at = now();
  end loop;

  update folders set updated_at = now() where id = v_item.folder_id;

  return api_item_json(v_item) || jsonb_build_object(
    'folderId', v_item.folder_id,
    'folderName', (select name from folders where id = v_item.folder_id)
  );
end;
$$;

create or replace function api_archive_item(p_user_id integer, p_item_id integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_folder_id integer;
begin
  update folder_items i
     set status = 'archived',
         archived_at = now()
   where i.id = p_item_id
     and i.user_id = p_user_id
     and i.status = 'active'
     and exists (
       select 1 from folders f where f.id = i.folder_id and f.status = 'active'
     )
   returning i.folder_id into v_folder_id;

  if v_folder_id is null then
    return null;
  end if;

  update folders set updated_at = now() where id = v_folder_id;

  return v_folder_id;
end;
$$;

create or replace function api_reveal_value(
  p_user_id integer,
  p_item_id integer,
  p_column_id integer
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('value', v.value, 'isSecret', c.is_secret)
    from item_values v
    join folder_items i on i.id = v.item_id
    join folder_columns c on c.id = v.column_id
    join folders f on f.id = i.folder_id
   where v.item_id = p_item_id
     and v.column_id = p_column_id
     and i.user_id = p_user_id
     and i.status = 'active'
     and f.status = 'active';
$$;

-- ---------------------------------------------------------------------------
--  Permissions
--
--  Only the service-role key may execute these functions or touch the tables.
--  The grants are guarded so the script also runs in local test databases.
-- ---------------------------------------------------------------------------
revoke all on function api_user_json(users) from public;
revoke all on function api_resolve_user(text, text, text, boolean, boolean) from public;
revoke all on function api_folder_json(integer) from public;
revoke all on function api_list_folders(integer) from public;
revoke all on function api_get_folder(integer, integer) from public;
revoke all on function api_create_folder(integer, text, text, text, text, jsonb) from public;
revoke all on function api_column_json(folder_columns) from public;
revoke all on function api_create_column(integer, integer, text, text, boolean, boolean, integer) from public;
revoke all on function api_get_column(integer, integer) from public;
revoke all on function api_column_values(integer, integer) from public;
revoke all on function api_update_column(integer, integer, text, text, boolean, boolean, jsonb) from public;
revoke all on function api_delete_column(integer, integer) from public;
revoke all on function api_reorder_columns(integer, integer, integer[]) from public;
revoke all on function api_reserve_item_id() from public;
revoke all on function api_item_json(folder_items) from public;
revoke all on function api_get_item(integer, integer) from public;
revoke all on function api_list_items(integer, integer, text, text, integer) from public;
revoke all on function api_search_items(integer, text, integer) from public;
revoke all on function api_create_item(integer, integer, integer, text, text, jsonb) from public;
revoke all on function api_update_item(integer, integer, boolean, text, boolean, text, jsonb, integer[]) from public;
revoke all on function api_archive_item(integer, integer) from public;
revoke all on function api_reveal_value(integer, integer, integer) from public;

do $$
declare
  signature text;
  role_name text;
begin
  foreach signature in array array[
    'api_user_json(users)',
    'api_resolve_user(text, text, text, boolean, boolean)',
    'api_folder_json(integer)',
    'api_list_folders(integer)',
    'api_get_folder(integer, integer)',
    'api_create_folder(integer, text, text, text, text, jsonb)',
    'api_column_json(folder_columns)',
    'api_create_column(integer, integer, text, text, boolean, boolean, integer)',
    'api_get_column(integer, integer)',
    'api_column_values(integer, integer)',
    'api_update_column(integer, integer, text, text, boolean, boolean, jsonb)',
    'api_delete_column(integer, integer)',
    'api_reorder_columns(integer, integer, integer[])',
    'api_reserve_item_id()',
    'api_item_json(folder_items)',
    'api_get_item(integer, integer)',
    'api_list_items(integer, integer, text, text, integer)',
    'api_search_items(integer, text, integer)',
    'api_create_item(integer, integer, integer, text, text, jsonb)',
    'api_update_item(integer, integer, boolean, text, boolean, text, jsonb, integer[])',
    'api_archive_item(integer, integer)',
    'api_reveal_value(integer, integer, integer)'
  ]
  loop
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on function %s from %I', signature, role_name);
      end if;
    end loop;

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', signature);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on users, folders, folder_columns, folder_items, item_values to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
  end if;
end;
$$;

-- Ask Supabase's PostgREST layer to pick up the new/replaced functions.
notify pgrst, 'reload schema';
