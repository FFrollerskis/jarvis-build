import { randomUUID } from "node:crypto";
import type { StripePaymentWriter } from "../src/index.ts";
import type { VippsPaymentObject, VippsPaymentWriter } from "../src/vipps-transport.ts";
import type { FikenGeneralJournalEntryWriter } from "../src/index.ts";

/**
 * WP-F1 (D-453): delte testdobler for dobbeltbetalings- og klasse D-kjede-testene. INGEN nettverk - alle leverandører er fakes som oppfører seg som de
 * ekte (Stripe/Vipps slår sammen kall med samme Idempotency-Key; Fiken/Neonomics gjør det IKKE), slik at en test faktisk kan telle «effekter hos leverandøren».
 */

export class Gate {
  readonly promise: Promise<void>;
  open!: () => void;
  constructor() { this.promise = new Promise<void>((resolve) => { this.open = resolve; }); }
}

/** Oppfører seg som Stripe: samme Idempotency-Key gir samme objekt (og teller bare ÉN effekt). */
export class StripeFake implements StripePaymentWriter {
  createCalls: Array<{ amountOre: number; idempotencyKey: string }> = [];
  refundCalls: Array<{ amountOre: number; idempotencyKey: string }> = [];
  gate: Gate | null = null;
  fail: (() => Error) | null = null;
  private readonly intentsByKey = new Map<string, { id: string }>();
  private readonly refundsByKey = new Map<string, { id: string }>();
  get distinctEffects(): number { return this.intentsByKey.size + this.refundsByKey.size; }
  async createPaymentIntent(input: { amountOre: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }) {
    this.createCalls.push({ amountOre: input.amountOre, idempotencyKey: input.idempotencyKey });
    if (this.gate) await this.gate.promise;
    if (this.fail) throw this.fail();
    const existing = this.intentsByKey.get(input.idempotencyKey) ?? { id: `pi_${randomUUID().slice(0, 8)}` };
    this.intentsByKey.set(input.idempotencyKey, existing);
    return { id: existing.id, object: "payment_intent" as const, amount: input.amountOre, currency: input.currency.toLowerCase(), status: "requires_payment_method", metadata: input.metadata };
  }
  async getPaymentIntent(id: string) { return { id, object: "payment_intent" as const, amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} }; }
  async createRefund(input: { stripePaymentIntentId: string; amountOre: number; idempotencyKey: string }) {
    this.refundCalls.push({ amountOre: input.amountOre, idempotencyKey: input.idempotencyKey });
    if (this.gate) await this.gate.promise;
    if (this.fail) throw this.fail();
    const existing = this.refundsByKey.get(input.idempotencyKey) ?? { id: `re_${randomUUID().slice(0, 8)}` };
    this.refundsByKey.set(input.idempotencyKey, existing);
    return { id: existing.id, object: "refund" as const, amount: input.amountOre, currency: "nok", status: "succeeded", payment_intent: input.stripePaymentIntentId, reason: null };
  }
  async getRefund(id: string) { return { id, object: "refund" as const, amount: 1, currency: "nok", status: "succeeded", payment_intent: "x", reason: null }; }
  async getBalance() { return { object: "balance" as const, available: [], pending: [] }; }
}

export class VippsFake implements VippsPaymentWriter {
  createCalls: Array<{ idempotencyKey: string }> = [];
  captureCalls: Array<{ amountOre: number; idempotencyKey: string }> = [];
  refundCalls: Array<{ amountOre: number; idempotencyKey: string }> = [];
  gate: Gate | null = null;
  fail: (() => Error) | null = null;
  async createPayment(input: { amountOre: number; currency: string; reference: string; idempotencyKey: string }): Promise<VippsPaymentObject> {
    this.createCalls.push({ idempotencyKey: input.idempotencyKey });
    if (this.gate) await this.gate.promise;
    if (this.fail) throw this.fail();
    return { reference: input.reference, state: "CREATED", amount: { currency: input.currency, value: input.amountOre } };
  }
  async getPayment(reference: string): Promise<VippsPaymentObject> { return { reference, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } }; }
  async capturePayment(input: { reference: string; amountOre: number; currency: string; idempotencyKey: string }): Promise<VippsPaymentObject> {
    this.captureCalls.push({ amountOre: input.amountOre, idempotencyKey: input.idempotencyKey });
    if (this.gate) await this.gate.promise;
    if (this.fail) throw this.fail();
    return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
  }
  async cancelPayment(reference: string): Promise<VippsPaymentObject> { return { reference, state: "CANCELLED", amount: { currency: "NOK", value: 10_000 } }; }
  async refundPayment(input: { reference: string; amountOre: number; currency: string; idempotencyKey: string }): Promise<VippsPaymentObject> {
    this.refundCalls.push({ amountOre: input.amountOre, idempotencyKey: input.idempotencyKey });
    if (this.gate) await this.gate.promise;
    if (this.fail) throw this.fail();
    return { reference: input.reference, state: "AUTHORIZED", amount: { currency: input.currency, value: input.amountOre } };
  }
  async checkCredentials(): Promise<void> {}
}

export class FikenFake implements FikenGeneralJournalEntryWriter {
  calls = 0;
  fail: (() => Error) | null = null;
  async createGeneralJournalEntry(input: { description: string; date: string }) {
    this.calls += 1;
    if (this.fail) throw this.fail();
    return { journalEntryId: 4242, description: input.description, date: input.date };
  }
  async listCompanies() { return []; }
}

export const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
export const http = (status: number, message = `provider_${status}`) => Object.assign(new Error(message), { httpStatus: status });

