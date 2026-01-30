import cron from 'node-cron';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { judgeArtworks, SimpleArtSubmission } from './ai-judge';

// Contract addresses
const PRIZE_POOL_ADDRESS = process.env.PRIZE_POOL_ADDRESS as `0x${string}`;
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

// Platform wallet for receiving fees
const PLATFORM_WALLET = process.env.PLATFORM_WALLET as `0x${string}`;

// Admin private key for automation (KEEP SECURE!)
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY as `0x${string}`;

// PrizePool ABI (minimal for our needs)
const PRIZE_POOL_ABI = [
  {
    name: 'finalizeGame',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'gameId', type: 'uint256' },
      { name: 'winnerIndex', type: 'uint256' }
    ],
    outputs: []
  },
  {
    name: 'startGame',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    name: 'currentGameId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'getGameInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [
      { name: 'startTime', type: 'uint256' },
      { name: 'endTime', type: 'uint256' },
      { name: 'prizePool', type: 'uint256' },
      { name: 'entryCount', type: 'uint256' },
      { name: 'finalized', type: 'bool' },
      { name: 'winner', type: 'address' }
    ]
  }
] as const;

// In-memory storage reference (will be set from main server)
let entriesStorage: Map<number, any[]>;

export function setEntriesStorage(storage: Map<number, any[]>) {
  entriesStorage = storage;
}

// Create blockchain clients
function getClients() {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http()
  });

  if (!ADMIN_PRIVATE_KEY) {
    throw new Error('ADMIN_PRIVATE_KEY not configured');
  }

  const account = privateKeyToAccount(ADMIN_PRIVATE_KEY);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http()
  });

  return { publicClient, walletClient, account };
}

// Main finalization logic
export async function finalizeCurrentGame(): Promise<{
  success: boolean;
  gameId?: number;
  winner?: { address: string; title: string; score: number };
  prizeAmount?: string;
  error?: string;
}> {
  console.log('🎮 Starting game finalization...');

  try {
    // Check if contract is deployed
    if (!PRIZE_POOL_ADDRESS || PRIZE_POOL_ADDRESS === '0x0000000000000000000000000000000000000000') {
      // Fallback: finalize without smart contract (for testing)
      return await finalizeWithoutContract();
    }

    const { publicClient, walletClient, account } = getClients();

    // Get current game ID
    const currentGameId = await publicClient.readContract({
      address: PRIZE_POOL_ADDRESS,
      abi: PRIZE_POOL_ABI,
      functionName: 'currentGameId'
    }) as bigint;

    const gameId = Number(currentGameId);
    console.log(`📊 Current game ID: ${gameId}`);

    // Get game info
    const gameInfo = await publicClient.readContract({
      address: PRIZE_POOL_ADDRESS,
      abi: PRIZE_POOL_ABI,
      functionName: 'getGameInfo',
      args: [currentGameId]
    }) as [bigint, bigint, bigint, bigint, boolean, string];

    const [startTime, endTime, prizePool, entryCount, finalized, winner] = gameInfo;

    if (finalized) {
      console.log('⚠️ Game already finalized');
      return { success: false, error: 'Game already finalized' };
    }

    if (Number(entryCount) === 0) {
      console.log('⚠️ No entries in this game');
      // Start new game anyway
      await startNewGame();
      return { success: false, error: 'No entries, started new game' };
    }

    // Get entries from storage
    const entries = entriesStorage?.get(gameId) || [];
    
    if (entries.length === 0) {
      console.log('⚠️ No entries found in storage');
      return { success: false, error: 'No entries in storage' };
    }

    // Judge all entries with AI
    console.log(`🤖 Judging ${entries.length} entries with AI...`);
    const submissions: SimpleArtSubmission[] = entries.map((e, i) => ({
      id: i.toString(),
      imageUrl: e.imageUrl,
      title: e.title,
      artist: e.playerAddress
    }));

    const scores = await judgeArtworks(submissions);
    
    // Find winner (highest total score)
    let winnerIndex = 0;
    let highestScore = 0;
    
    scores.forEach((score, index) => {
      const total = score.creativity + score.technique + score.theme;
      if (total > highestScore) {
        highestScore = total;
        winnerIndex = index;
      }
    });

    const winnerEntry = entries[winnerIndex];
    const winnerScore = scores[winnerIndex];

    console.log(`🏆 Winner: ${winnerEntry.title} by ${winnerEntry.playerAddress}`);
    console.log(`   Score: ${highestScore}/30 (C:${winnerScore.creativity} T:${winnerScore.technique} TH:${winnerScore.theme})`);

    // Call smart contract to finalize
    console.log('📝 Calling finalizeGame on smart contract...');
    const hash = await walletClient.writeContract({
      address: PRIZE_POOL_ADDRESS,
      abi: PRIZE_POOL_ABI,
      functionName: 'finalizeGame',
      args: [currentGameId, BigInt(winnerIndex)]
    });

    console.log(`✅ Transaction submitted: ${hash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

    // Start new game
    await startNewGame();

    const prizeAmountFormatted = formatUnits(prizePool, 6);

    return {
      success: true,
      gameId,
      winner: {
        address: winnerEntry.playerAddress,
        title: winnerEntry.title,
        score: highestScore
      },
      prizeAmount: prizeAmountFormatted
    };

  } catch (error) {
    console.error('❌ Finalization error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// Finalize without smart contract (for testing/demo)
async function finalizeWithoutContract(): Promise<{
  success: boolean;
  gameId?: number;
  winner?: { address: string; title: string; score: number };
  prizeAmount?: string;
  error?: string;
}> {
  console.log('📝 Finalizing without smart contract (demo mode)...');

  const gameId = 1; // Default game
  const entries = entriesStorage?.get(gameId) || [];

  if (entries.length === 0) {
    console.log('⚠️ No entries to judge');
    return { success: false, error: 'No entries' };
  }

  // Judge all entries with AI
  console.log(`🤖 Judging ${entries.length} entries with AI...`);
  const submissions: SimpleArtSubmission[] = entries.map((e, i) => ({
    id: i.toString(),
    imageUrl: e.imageUrl,
    title: e.title,
    artist: e.playerAddress
  }));

  const scores = await judgeArtworks(submissions);

  // Find winner
  let winnerIndex = 0;
  let highestScore = 0;

  scores.forEach((score, index) => {
    const total = score.creativity + score.technique + score.theme;
    if (total > highestScore) {
      highestScore = total;
      winnerIndex = index;
    }
  });

  const winnerEntry = entries[winnerIndex];
  const winnerScore = scores[winnerIndex];

  console.log(`🏆 Winner: ${winnerEntry.title} by ${winnerEntry.playerAddress}`);
  console.log(`   Score: ${highestScore}/30`);
  console.log(`   Reasoning: ${winnerScore.reasoning}`);

  // Calculate prize (demo: count entries * $0.05 * 90%)
  const prizeAmount = (entries.length * 0.05 * 0.9).toFixed(2);

  return {
    success: true,
    gameId,
    winner: {
      address: winnerEntry.playerAddress,
      title: winnerEntry.title,
      score: highestScore
    },
    prizeAmount
  };
}

// Start a new game
async function startNewGame(): Promise<void> {
  console.log('🆕 Starting new game...');

  if (!PRIZE_POOL_ADDRESS || PRIZE_POOL_ADDRESS === '0x0000000000000000000000000000000000000000') {
    console.log('📝 Demo mode: New game started (no contract)');
    return;
  }

  try {
    const { publicClient, walletClient } = getClients();

    const hash = await walletClient.writeContract({
      address: PRIZE_POOL_ADDRESS,
      abi: PRIZE_POOL_ABI,
      functionName: 'startGame',
      args: []
    });

    await publicClient.waitForTransactionReceipt({ hash });
    console.log('✅ New game started');
  } catch (error) {
    console.error('❌ Failed to start new game:', error);
  }
}

// Schedule daily finalization (runs at 00:00 UTC)
export function startCronScheduler(): void {
  console.log('⏰ Starting cron scheduler...');

  // Run every day at 00:00 UTC
  cron.schedule('0 0 * * *', async () => {
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('🎯 DAILY GAME FINALIZATION - ' + new Date().toISOString());
    console.log('═══════════════════════════════════════');

    const result = await finalizeCurrentGame();

    if (result.success) {
      console.log('');
      console.log('🎉 GAME FINALIZED SUCCESSFULLY!');
      console.log(`   Winner: ${result.winner?.title}`);
      console.log(`   Address: ${result.winner?.address}`);
      console.log(`   Prize: $${result.prizeAmount} USDC`);
      console.log('');
    } else {
      console.log(`❌ Finalization failed: ${result.error}`);
    }

    console.log('═══════════════════════════════════════');
    console.log('');
  }, {
    timezone: 'UTC'
  });

  console.log('✅ Cron scheduled: Daily at 00:00 UTC');

  // Also run every hour for testing (can be disabled in production)
  if (process.env.NODE_ENV !== 'production') {
    cron.schedule('0 * * * *', () => {
      console.log('⏰ Hourly check (dev mode) - ' + new Date().toISOString());
    });
  }
}

// Manual trigger for testing
export async function manualFinalize(): Promise<any> {
  console.log('🔧 Manual finalization triggered');
  return await finalizeCurrentGame();
}
