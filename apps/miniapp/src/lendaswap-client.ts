import { Client, IdbSwapStorage, IdbWalletStorage } from "@satora/swap";
import type { LendaswapLike } from "@railkit/adapters";
import type { EvmChain } from "@railkit/core";

/**
 * Circle's native USDC. Checked against LendaSwap's own /tokens list on 2026-10-26 (they agree);
 * confirm against Circle's published addresses before trusting real money to them.
 */
const USDC: Record<EvmChain, { chainId: number; address: string }> = {
  polygon: { chainId: 137, address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  ethereum: { chainId: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  arbitrum: { chainId: 42161, address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
};

let clientPromise: Promise<Client> | undefined;

/** One client per page. Its swap keys come from a wallet the SDK keeps in this browser's IndexedDB. */
function getClient(): Promise<Client> {
  clientPromise ??= Client.builder().withSignerStorage(new IdbWalletStorage()).withSwapStorage(new IdbSwapStorage()).build();
  return clientPromise;
}

export const lendaswapClient: LendaswapLike = {
  async createSwap({ chain, targetAddress, targetUnits }) {
    const client = await getClient();
    const token = USDC[chain];
    const { response } = await client.createLightningToEvmSwap({
      targetAddress,
      tokenAddress: token.address,
      evmChainId: token.chainId,
      targetAmount: BigInt(targetUnits),
    });
    return {
      id: response.id,
      invoice: response.bolt11_invoice,
      hashLock: response.hash_lock,
      sourceSats: response.source_amount,
      targetUnits: response.target_amount,
      feeSats: String(response.fee_sats),
      invoiceExpiresAt: response.invoice_expires_at ?? null,
    };
  },

  async getSwap(id) {
    const swap = await (await getClient()).getSwap(id);
    return { status: String((swap as { status?: unknown }).status) };
  },

  async claim(id) {
    return (await getClient()).claim(id);
  },
};
