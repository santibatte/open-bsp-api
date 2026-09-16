set check_function_bodies = off;

-- Bulk/campaign sends (content.broadcast, see
-- consultorio_dermatologico/scripts/lib/meta_send_log.py) are stored in
-- `messages` so the bot and the UI can see them in the conversation, but a
-- mass send must not bump a conversation to the top of the inbox as if a
-- real message had just happened. Excludes them from the last-message-at
-- computation that drives list_conversations_page's ordering/pagination
-- cursor. Falls back to the broadcast message (and null when there is none
-- at all) so the conversation still sorts somewhere instead of disappearing.
CREATE OR REPLACE FUNCTION public.list_conversations_page(p_organization_id uuid, p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_per_conversation integer DEFAULT 10)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  _conversations json;
  _messages json;
  _conversation_ids uuid[];
begin
  with activity as (
    select c.*, lm.timestamp as last_message_at
    from public.conversations c
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
$function$
;
