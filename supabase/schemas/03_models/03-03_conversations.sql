create table public.conversations (
  organization_id uuid not null,
  id uuid default gen_random_uuid() not null,
  service public.service not null,
  organization_address text not null,
  contact_address text, -- one of contact_address or group_address
  group_address text,   -- must be not null for whatsapp service
  name text,
  extra jsonb,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.conversations
add constraint conversations_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.conversations
add constraint conversations_pkey
primary key (id);

alter table only public.conversations
add constraint conversations_organization_address_fkey
foreign key (organization_id, organization_address)
references public.organizations_addresses(organization_id, address)
on delete no action;

alter table only public.conversations
add constraint conversations_contact_address_fkey
foreign key (organization_id, service, contact_address)
references public.contacts_addresses(organization_id, service, address)
on delete no action;

create index conversations_organization_id_idx
on public.conversations
using btree (organization_id);

create index conversations_updated_at_idx
on public.conversations
using btree (updated_at);

create index conversations_organization_address_idx
on public.conversations
using btree (organization_address);

create index conversations_contact_address_idx
on public.conversations
using btree (contact_address);

create index conversations_group_address_idx
on public.conversations
using btree (group_address);

-- At most one active conversation per contact (and, separately, per group) —
-- prevents `before_insert_on_messages()` from creating a duplicate conversation
-- when two inserts for the same contact race each other (e.g. a campaign send
-- via the Graph API and Meta's webhook echo of that same send arriving at
-- nearly the same time, before either transaction has committed).
create unique index conversations_active_contact_uniq
on public.conversations
using btree (organization_id, organization_address, service, contact_address)
where (group_address is null and status = 'active');

create unique index conversations_active_group_uniq
on public.conversations
using btree (organization_id, organization_address, service, group_address)
where (group_address is not null and status = 'active');

create trigger handle_new_conversation
before insert
on public.conversations
for each row
execute function public.before_insert_on_conversations();

create trigger z_notify_webhook_conversations
after insert or update
on public.conversations
for each row
execute function public.notify_webhook();

create trigger set_extra
before update
on public.conversations
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.conversations
for each row
execute function public.moddatetime('updated_at');
