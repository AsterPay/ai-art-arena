import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// USDC addresses
const USDC_ADDRESSES = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  baseSepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
} as const;

// Entry fee: $0.05 = 50000 (6 decimals)
const ENTRY_FEE = BigInt(50000);

export interface PaymentIntent {
  id: string;
  amount: string;
  recipientAddress: string;
  chainId: number;
  status: 'pending' | 'paid' | 'expired';
  createdAt: number;
  expiresAt: number;
  metadata?: {
    gameId: number;
    playerAddress: string;
  };
}

export interface PaymentVerification {
  valid: boolean;
  txHash?: string;
  amount?: bigint;
  error?: string;
}

export class X402PaymentService {
  private chain: typeof base | typeof baseSepolia;
  private usdcAddress: `0x${string}`;
  private prizePoolAddress: `0x${string}`;
  private publicClient: any;

  constructor(
    prizePoolAddress: string,
    isTestnet: boolean = true
  ) {
    this.chain = isTestnet ? baseSepolia : base;
    this.usdcAddress = isTestnet ? USDC_ADDRESSES.baseSepolia : USDC_ADDRESSES.base;
    this.prizePoolAddress = prizePoolAddress as `0x${string}`;
    
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http()
    });
  }

  /**
   * Create a payment intent for game entry
   */
  createPaymentIntent(gameId: number, playerAddress: string): PaymentIntent {
    const id = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    return {
      id,
      amount: formatUnits(ENTRY_FEE, 6), // $0.05
      recipientAddress: this.prizePoolAddress,
      chainId: this.chain.id,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
      metadata: {
        gameId,
        playerAddress
      }
    };
  }

  /**
   * Generate x402 response headers
   */
  generateX402Headers(paymentIntent: PaymentIntent): Record<string, string> {
    return {
      'X-Payment-Required': 'true',
      'X-Payment-Amount': paymentIntent.amount,
      'X-Payment-Currency': 'USDC',
      'X-Payment-Chain': this.chain.name,
      'X-Payment-Chain-Id': this.chain.id.toString(),
      'X-Payment-Recipient': paymentIntent.recipientAddress,
      'X-Payment-Token': this.usdcAddress,
      'X-Payment-Intent-Id': paymentIntent.id,
      'X-Payment-Expires': paymentIntent.expiresAt.toString()
    };
  }

  /**
   * Verify payment on-chain
   */
  async verifyPayment(
    txHash: `0x${string}`,
    expectedAmount: bigint = ENTRY_FEE
  ): Promise<PaymentVerification> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: txHash
      });

      if (receipt.status !== 'success') {
        return { valid: false, error: 'Transaction failed' };
      }

      // Check for USDC Transfer event to prize pool
      const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      
      const transferLog = receipt.logs.find((log: any) => 
        log.address.toLowerCase() === this.usdcAddress.toLowerCase() &&
        log.topics[0] === transferTopic &&
        log.topics[2]?.toLowerCase().includes(this.prizePoolAddress.slice(2).toLowerCase())
      );

      if (!transferLog) {
        return { valid: false, error: 'No transfer to prize pool found' };
      }

      // Decode amount from log data
      const amount = BigInt(transferLog.data);
      
      if (amount < expectedAmount) {
        return { 
          valid: false, 
          error: `Insufficient amount: ${formatUnits(amount, 6)} < ${formatUnits(expectedAmount, 6)}`
        };
      }

      return {
        valid: true,
        txHash,
        amount
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Verification failed'
      };
    }
  }

  /**
   * Get USDC balance for an address
   */
  async getUsdcBalance(address: `0x${string}`): Promise<string> {
    const balance = await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: [{
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }]
      }],
      functionName: 'balanceOf',
      args: [address]
    });

    return formatUnits(balance as bigint, 6);
  }

  /**
   * Get current prize pool balance
   */
  async getPrizePoolBalance(): Promise<string> {
    return this.getUsdcBalance(this.prizePoolAddress);
  }
}

export default X402PaymentService;
