// ── Method registry: maps eth-rpc method names to handler factories ──

import type { MethodFactory, MethodHandler, MethodContext } from "../types.js";

const factories = new Map<string, MethodFactory>();

/** Register a method handler factory */
export function registerMethod(method: string, factory: MethodFactory): void {
  factories.set(method, factory);
}

/** Create all method handlers for a given context */
export function createHandlers(ctx: MethodContext): Map<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>();
  for (const [method, factory] of factories) {
    handlers.set(method, factory(ctx));
  }
  return handlers;
}

/** Check if a method is registered */
export function hasMethod(method: string): boolean {
  return factories.has(method);
}

/** Get all registered method names */
export function getRegisteredMethods(): string[] {
  return Array.from(factories.keys());
}
