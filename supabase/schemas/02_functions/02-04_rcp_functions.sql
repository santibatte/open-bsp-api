create function public.init_data(
  p_organization_id uuid,
  p_limit integer default 200,
  p_per_conversation integer default 10,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns json
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  _messages json;
  _conversations json;
  _conversation_ids uuid[];
begin
  -- Windowed messages: up to p_per_conversation per conversation, total p_limit
  with windowed as (
    select m.*,
      row_number() over (
        partition by m.conversation_id
        order by m.timestamp desc
      ) as rn
    from public.messages m
    where m.organization_id = p_organization_id
      and (p_since is null or m.timestamp > p_since)
      and (p_until is null or m.timestamp < p_until)
  ),
  limited as (
    select * from windowed
    where rn <= p_per_conversation
    order by timestamp desc
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(l.*)), '[]'::json),
    array_agg(distinct l.conversation_id)
  into _messages, _conversation_ids
  from limited l;

  -- Fetch conversations for the messages returned
  select coalesce(json_agg(row_to_json(c.*)), '[]'::json)
  into _conversations
  from public.conversations c
  where c.id = any(_conversation_ids);

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$$;

-- Pages a single conversation's message history backwards in time, for
-- loading older messages once a chat is already open (init_data only
-- preloads the last p_per_conversation messages per conversation).
create function public.get_conversation_history(
  p_conversation_id uuid,
  p_before timestamptz default null,
  p_limit integer default 30
)
returns json
language sql
stable
security invoker
set search_path to ''
as $$
  select coalesce(json_agg(row_to_json(m.*)), '[]'::json)
  from (
    select *
    from public.messages
    where conversation_id = p_conversation_id
      and (p_before is null or timestamp < p_before)
    order by timestamp desc
    limit p_limit
  ) m;
$$;

-- Pages conversations by their own most recent message, independent of
-- init_data's org-wide message window — a conversation with no recent
-- activity (but plenty of overall org traffic since) no longer falls out
-- of view. Returns each conversation together with up to p_per_conversation
-- of its most recent messages, same shape as init_data.
create function public.list_conversations_page(
  p_organization_id uuid,
  p_limit integer default 50,
  p_before timestamptz default null,
  p_per_conversation integer default 10
)
returns json
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  _conversations json;
  _messages json;
  _conversation_ids uuid[];
begin
  with activity as (
    select c.*, lm.timestamp as last_message_at
    from public.conversations c
    -- Bulk/campaign sends (content.broadcast, see
    -- consultorio_dermatologico/scripts/lib/meta_send_log.py) are excluded:
    -- they are stored so the bot/UI can see them in the conversation, but a
    -- mass send must not bump a conversation to the top of the inbox as if a
    -- real message had just happened. Falls back to the broadcast message
    -- (and null when there is none at all) so the conversation still sorts
    -- somewhere instead of disappearing.
    left join lateral (
      select m.timestamp
      from public.messages m
      where m.conversation_id = c.id
        and not coalesce((m.content->>'broadcast')::boolean, false)
      order by m.timestamp desc
      limit 1
    ) lm on true
    where c.organization_id = p_organization_id
      and c.status = 'active'
  ),
  page as (
    select *
    from activity
    where p_before is null
      or last_message_at is null
      or last_message_at < p_before
    order by last_message_at desc nulls last
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(page.*)), '[]'::json),
    array_agg(page.id)
  into _conversations, _conversation_ids
  from page;

  with windowed as (
    select m.*,
      row_number() over (
        partition by m.conversation_id
        order by m.timestamp desc
      ) as rn
    from public.messages m
    where m.conversation_id = any(_conversation_ids)
  )
  select coalesce(json_agg(row_to_json(w.*)), '[]'::json)
  into _messages
  from windowed w
  where w.rn <= p_per_conversation;

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$$;
