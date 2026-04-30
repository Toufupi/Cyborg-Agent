import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { CyborgSession } from "./session.js";

export const A2AMessageSchema = z.object({
  schema: z.literal("cyborg.a2a.message.v0.1"),
  id: z.string().min(1),
  time: z.string().datetime(),
  conversation_id: z.string().min(1),
  parent_id: z.string().min(1).optional(),
  from: z.object({
    agent: z.string().min(1),
    session_id: z.string().min(1).optional()
  }),
  to: z.object({
    agent: z.string().min(1),
    session_id: z.string().min(1).optional()
  }),
  type: z.enum([
    "delegate",
    "accept",
    "progress",
    "result",
    "error",
    "cancel"
  ]),
  task: z.string().min(1).optional(),
  content: z.string().max(8000).optional(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional()
  }).optional()
});

export const A2ATranscriptSchema = z.object({
  schema: z.literal("cyborg.a2a.transcript.v0.1"),
  conversation_id: z.string().min(1),
  created_at: z.string().datetime(),
  messages: z.array(A2AMessageSchema)
});

export type A2AMessage = z.output<typeof A2AMessageSchema>;
export type A2ATranscript = z.output<typeof A2ATranscriptSchema>;
export type A2AMessageType = A2AMessage["type"];

export interface CreateA2AMessageInput {
  conversationId: string;
  parentId?: string;
  from: A2AMessage["from"];
  to: A2AMessage["to"];
  type: A2AMessageType;
  task?: string;
  content?: string;
  data?: unknown;
  error?: A2AMessage["error"];
}

export function createA2AConversationId(prefix = "a2a") {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${nanoid(8)}`;
}

export function createA2AMessage(input: CreateA2AMessageInput): A2AMessage {
  return A2AMessageSchema.parse({
    schema: "cyborg.a2a.message.v0.1",
    id: `msg-${nanoid(10)}`,
    time: new Date().toISOString(),
    conversation_id: input.conversationId,
    parent_id: input.parentId,
    from: input.from,
    to: input.to,
    type: input.type,
    task: input.task,
    content: input.content,
    data: input.data,
    error: input.error
  });
}

export function createA2ATranscript(conversationId = createA2AConversationId()): A2ATranscript {
  return {
    schema: "cyborg.a2a.transcript.v0.1",
    conversation_id: conversationId,
    created_at: new Date().toISOString(),
    messages: []
  };
}

export function appendA2AMessage(transcript: A2ATranscript, message: A2AMessage) {
  if (message.conversation_id !== transcript.conversation_id) {
    throw new Error(`A2A message conversation '${message.conversation_id}' does not match transcript '${transcript.conversation_id}'.`);
  }
  transcript.messages.push(message);
  return message;
}

export function transcriptPath(session: CyborgSession) {
  return path.join(session.runDir, "a2a.json");
}

export async function saveA2ATranscript(session: CyborgSession, transcript: A2ATranscript) {
  await mkdir(session.runDir, { recursive: true });
  const file = transcriptPath(session);
  await writeFile(file, `${JSON.stringify(A2ATranscriptSchema.parse(transcript), null, 2)}\n`, "utf8");
  return { file, transcript };
}

export async function loadA2ATranscript(file: string) {
  return A2ATranscriptSchema.parse(JSON.parse(await readFile(path.resolve(file), "utf8")));
}
