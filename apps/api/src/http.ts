import type { FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, type ZodTypeAny } from "zod";
import { DomainError, ForbiddenError, type Actor } from "@lead/core";
import type { Role } from "@lead/db";
import { logger } from "@lead/config";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
  totpEnabled: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
    sessionId?: string;
  }
}

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data ?? {});
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.user) throw new ForbiddenError("Not signed in");
  return { type: "user", id: req.user.id, ip: req.ip };
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new DomainError("unauthenticated", "Please sign in", 401);
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): SessionUser {
  const u = requireUser(req);
  if (!roles.includes(u.role)) throw new ForbiddenError(`Requires role: ${roles.join(" or ")}`);
  return u;
}

export const isManager = (u: SessionUser) => u.role === "admin" || u.role === "manager";

/** Rep: own leads + the unassigned queue (§11.1). Viewer: no lead content. */
export function canSeeLead(u: SessionUser, lead: { ownerId: string | null }): boolean {
  if (isManager(u)) return true;
  if (u.role === "rep") return lead.ownerId === u.id || lead.ownerId === null;
  return false;
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof DomainError) {
    return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "invalid_input", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), details: err.issues });
  }
  const e = err as { statusCode?: number; message?: string; code?: string };
  if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message });
  logger.error({ err, url: req.url }, "unhandled API error");
  return reply.code(500).send({ error: "internal", message: "Something went wrong. It has been logged." });
}

export const uuid = z.string().uuid();
export const idParam = z.object({ id: uuid });
