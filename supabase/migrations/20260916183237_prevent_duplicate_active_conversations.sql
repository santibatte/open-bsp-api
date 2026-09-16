set check_function_bodies = off;

-- At most one active conversation per contact (and, separately, per group) —
-- prevents before_insert_on_messages() from creating a duplicate conversation
-- when two inserts for the same contact race each other (e.g. a campaign send
-- via the Graph API and Meta's webhook echo of that same send arriving at
-- nearly the same time, before either transaction has committed).
CREATE UNIQUE INDEX conversations_active_contact_uniq
ON public.conversations
USING btree (organization_id, organization_address, service, contact_address)
WHERE (group_address IS NULL AND status = 'active');

CREATE UNIQUE INDEX conversations_active_group_uniq
ON public.conversations
USING btree (organization_id, organization_address, service, group_address)
WHERE (group_address IS NOT NULL AND status = 'active');

CREATE OR REPLACE FUNCTION public.before_insert_on_messages()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- If conversation_id is already provided, proceed as is
  if new.conversation_id is not null then
    return new;
  end if;

  -- Look up conversation_id from conversation table. Group conversations
  -- are keyed by group_address alone (contact_address null on the
  -- conversation; the per-message sender lives on messages.contact_address).
  if new.group_address is not null then
    select id into new.conversation_id
    from public.conversations
    where organization_address = new.organization_address
      and group_address = new.group_address
      and service = new.service
      and status = 'active'
    order by created_at desc
    limit 1;
  else
    select id into new.conversation_id
    from public.conversations
    where organization_address = new.organization_address
      and contact_address is not distinct from new.contact_address
      and group_address is null
      and service = new.service
      and status = 'active'
    order by created_at desc
    limit 1;
  end if;

  -- Create conversation if it doesn't exist
  if new.conversation_id is null then
    begin
      insert into public.conversations (
        organization_id,
        organization_address,
        contact_address,
        group_address,
        service
      ) values (
        new.organization_id,
        new.organization_address,
        case when new.group_address is null then new.contact_address end,
        new.group_address,
        new.service
      )
      returning id into new.conversation_id;
    exception when unique_violation then
      -- Lost the race: some other concurrent insert (e.g. a campaign message
      -- sent straight to the Graph API and Meta's webhook echo of that same
      -- send) already created the active conversation for this contact/group
      -- between our select above and this insert. Reuse it instead of
      -- erroring out or creating a second one.
      if new.group_address is not null then
        select id into new.conversation_id
        from public.conversations
        where organization_address = new.organization_address
          and group_address = new.group_address
          and service = new.service
          and status = 'active'
        order by created_at desc
        limit 1;
      else
        select id into new.conversation_id
        from public.conversations
        where organization_address = new.organization_address
          and contact_address is not distinct from new.contact_address
          and group_address is null
          and service = new.service
          and status = 'active'
        order by created_at desc
        limit 1;
      end if;
    end;
  end if;

  return new;
end;
$function$
;
