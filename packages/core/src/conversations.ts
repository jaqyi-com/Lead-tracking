import { and, desc, eq, sql } from "drizzle-orm";
import { conversations, type Channel, type Db } from "@lead/db";
import { ORG_ID } from "./support";

export type Conversation = typeof conversations.$inferSelect;

/** One conversation per channel per lead (§7.1). */
export async function getOrCreateConversation(
  tx: Db,
  input: {
    leadId: string;
    contactId: string;
    channel: Channel;
    assignedTo?: string | null;
    subject?: string | null;
    providerThreadRef?: string | null;
    waNumberId?: string | null;
    toAddress?: string | null;
    mailboxConnectionId?: string | null;
    isJunk?: boolean;
  },
): Promise<{ conversation: Conversation; created: boolean }> {
  const [existing] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.leadId, input.leadId), eq(conversations.channel, input.channel)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (existing) {
    const patch: Partial<Conversation> = {};
    if (!existing.subject && input.subject) patch.subject = input.subject;
    if (!existing.providerThreadRef && input.providerThreadRef) patch.providerThreadRef = input.providerThreadRef;
    if (!existing.mailboxConnectionId && input.mailboxConnectionId) patch.mailboxConnectionId = input.mailboxConnectionId;
    if (!existing.waNumberId && input.waNumberId) patch.waNumberId = input.waNumberId;
    if (Object.keys(patch).length) await tx.update(conversations).set(patch).where(eq(conversations.id, existing.id));
    return { conversation: { ...existing, ...patch }, created: false };
  }
  const [c] = await tx
    .insert(conversations)
    .values({
      orgId: ORG_ID,
      leadId: input.leadId,
      contactId: input.contactId,
      channel: input.channel,
      assignedTo: input.assignedTo ?? null,
      subject: input.subject ?? null,
      providerThreadRef: input.providerThreadRef ?? null,
      waNumberId: input.waNumberId ?? null,
      toAddress: input.toAddress ?? null,
      mailboxConnectionId: input.mailboxConnectionId ?? null,
      isJunk: input.isJunk ?? false,
      state: "open",
    })
    .returning();
  return { conversation: c!, created: true };
}

export async function getConversation(db: Db, id: string): Promise<Conversation | undefined> {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id));
  return c;
}

export async function markConversationRead(db: Db, id: string): Promise<void> {
  await db.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, id));
}

export async function bumpUnread(tx: Db, id: string): Promise<void> {
  await tx.update(conversations).set({ unreadCount: sql`${conversations.unreadCount} + 1` }).where(eq(conversations.id, id));
}
