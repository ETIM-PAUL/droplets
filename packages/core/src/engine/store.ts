import type { Order, OrderStore } from "./types";

/** In-memory store for tests and local runs; Postgres replaces it behind the same interface. */
export class MemoryOrderStore implements OrderStore {
  private orders = new Map<string, Order>();
  async get(id: string) {
    return this.orders.get(id);
  }
  async put(order: Order) {
    this.orders.set(order.id, order);
  }
  async list() {
    return [...this.orders.values()];
  }
}
