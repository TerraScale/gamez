/**
 * The payment providers (wave-C.md §8, provider.ts contract). OWNER: T-pay.
 *
 *   providersFor(env, url)  every provider, each with `enabled` set from its keys.
 *                           The stub is enabled when PAYMENTS_STUB === "1", or when
 *                           PAYMENTS_STUB !== "0" and the host is a dev host.
 */
import type { PaymentProviderInfo } from "@gamez/protocol";
import type { Env } from "../contracts.ts";
import { isDevHost } from "../http.ts";
import { AsaasProvider } from "./asaas.ts";
import { MercadoPagoProvider } from "./mercadopago.ts";
import type { PaymentProvider } from "./provider.ts";
import { StripeProvider } from "./stripe.ts";
import { StubProvider } from "./stub.ts";

export type PaymentsEnv = Pick<
  Env,
  | "AUTH_SECRET"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "ASAAS_API_KEY"
  | "ASAAS_WEBHOOK_TOKEN"
  | "ASAAS_ENV"
  | "MERCADOPAGO_ACCESS_TOKEN"
  | "MERCADOPAGO_WEBHOOK_SECRET"
  | "PAYMENTS_STUB"
>;

/** Injectable clocks and fetch for tests; production passes nothing. */
export interface ProviderDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export function stubEnabled(env: Pick<PaymentsEnv, "PAYMENTS_STUB">, url: URL): boolean {
  if (env.PAYMENTS_STUB === "1") return true;
  // Dev-host rules only: the OAuth override does not change payments.
  return env.PAYMENTS_STUB !== "0" && isDevHost(url, {});
}

export function providersFor(
  env: PaymentsEnv,
  url: URL,
  deps: ProviderDeps = {},
): PaymentProvider[] {
  return [
    new StripeProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      fetch: deps.fetch,
      now: deps.now,
    }),
    new AsaasProvider({
      apiKey: env.ASAAS_API_KEY,
      webhookToken: env.ASAAS_WEBHOOK_TOKEN,
      env: env.ASAAS_ENV,
      fetch: deps.fetch,
      now: deps.now,
    }),
    new MercadoPagoProvider({
      accessToken: env.MERCADOPAGO_ACCESS_TOKEN,
      webhookSecret: env.MERCADOPAGO_WEBHOOK_SECRET,
      fetch: deps.fetch,
      now: deps.now,
    }),
    new StubProvider({ authSecret: env.AUTH_SECRET, enabled: stubEnabled(env, url) }),
  ];
}

export function providerInfo(p: PaymentProvider): PaymentProviderInfo {
  return {
    id: p.id,
    enabled: p.enabled,
    stub: p.stub,
    currencies: [...p.currencies],
    methods: [...p.methods],
  };
}

export function providerById(
  providers: readonly PaymentProvider[],
  id: string,
): PaymentProvider | null {
  return providers.find((p) => p.id === id) ?? null;
}

export { AsaasProvider, MercadoPagoProvider, StripeProvider, StubProvider };
export type { PaymentProvider } from "./provider.ts";
