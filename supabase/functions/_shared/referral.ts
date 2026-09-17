import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "./logger.ts";

/** First inbound message on this contact's conversation that carries a
 * Click-to-WhatsApp referral — Meta only attaches `ctwa_clid` to the message
 * that opened the conversation, not to every message after it. */
export async function findCtwaClid(
  client: SupabaseClient,
  organizationId: string,
  contactAddress: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("messages")
    .select("content")
    .eq("organization_id", organizationId)
    .eq("contact_address", contactAddress)
    .eq("service", "whatsapp")
    .eq("direction", "incoming")
    .order("timestamp", { ascending: true })
    .limit(20); // referral, if present, is on one of the first few messages

  if (error) {
    log.error("Failed to look up messages for ctwa_clid", { error });
    throw error;
  }

  for (const row of data ?? []) {
    const content = row.content as { referral?: { ctwa_clid?: string } };
    if (content?.referral?.ctwa_clid) return content.referral.ctwa_clid;
  }

  return null;
}
