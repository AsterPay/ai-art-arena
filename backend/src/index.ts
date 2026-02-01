import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import AIJudgeService from './services/ai-judge';
import X402PaymentService from './services/x402-payment';
import { setEntriesStorage, startCronScheduler, manualFinalize } from './services/game-automation';
import * as db from './services/database';

// Environment
const PORT = parseInt(process.env.PORT || '3001');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PRIZE_POOL_ADDRESS = process.env.PRIZE_POOL_ADDRESS || '0x0000000000000000000000000000000000000000';
const IS_TESTNET = process.env.NODE_ENV !== 'production';

// Services - initialized lazily to prevent startup crashes
let aiJudge: AIJudgeService | null = null;
let paymentService: X402PaymentService | null = null;

try {
  if (ANTHROPIC_API_KEY) {
    aiJudge = new AIJudgeService(ANTHROPIC_API_KEY);
    console.log('✅ AI Judge service initialized');
  } else {
    console.log('⚠️ ANTHROPIC_API_KEY not set - AI judging disabled');
  }
} catch (e) {
  console.log('⚠️ AI Judge service failed to initialize:', e);
}

try {
  paymentService = new X402PaymentService(PRIZE_POOL_ADDRESS, IS_TESTNET);
  console.log('✅ Payment service initialized');
} catch (e) {
  console.log('⚠️ Payment service failed to initialize:', e);
}

// In-memory storage (replace with DB in production)
interface Submission {
  id: string;
  gameId: number;
  imageUrl: string;
  title: string;
  playerAddress: string;
  timestamp: number;
  paymentTxHash?: string;
}

interface Game {
  id: number;
  startTime: number;
  endTime: number;
  submissions: Submission[];
  finalized: boolean;
  winnerId?: string;
}

let currentGameId = 0;
const games: Map<number, Game> = new Map();

// Entries storage for automation (maps gameId -> entries array)
const entriesForAutomation = new Map<number, any[]>();

// Validation schemas
const SubmitSchema = z.object({
  imageUrl: z.string().url(),
  title: z.string().min(1).max(100),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  paymentTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/)
});

const app = Fastify({ logger: true });

// Register plugins
app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
});

// ============ Routes ============

// Health check
app.get('/health', async () => {
  return { status: 'ok', gameId: currentGameId };
});

// Get current game
app.get('/api/game', async () => {
  // Try database first, fallback to in-memory
  try {
    if (process.env.DATABASE_URL) {
      // Always get the latest non-finalized game, or create new one
      const latestGameId = await db.getLatestGameId();
      let gameData = await db.getOrCreateGame(latestGameId);
      
      // If latest game is finalized, create a new one
      if (gameData.finalized) {
        const newGameId = await db.createNextGame();
        gameData = await db.getOrCreateGame(newGameId);
      }
      
      currentGameId = gameData.gameId; // Update global state
      const entries = await db.getEntriesForGame(gameData.gameId);
      
      // Calculate time remaining (0 if not started yet)
      const timeRemaining = gameData.started && gameData.endTime > 0 
        ? Math.max(0, gameData.endTime - Date.now())
        : 0;
      
      return {
        gameId: gameData.gameId,
        startTime: gameData.startTime,
        endTime: gameData.endTime,
        entryCount: entries.length,
        prizePool: (entries.length * 0.05).toFixed(2), // Calculate from entries
        timeRemaining,
        finalized: gameData.finalized,
        started: gameData.started,
        status: gameData.finalized 
          ? 'finalized' 
          : gameData.started 
            ? (timeRemaining > 0 ? 'active' : 'ended') 
            : 'waiting'
      };
    }
  } catch (e) {
    console.log('Database not available, using in-memory');
  }

  const game = games.get(currentGameId);
  if (!game) {
    return { error: 'No active game', gameId: null };
  }

  return {
    gameId: game.id,
    startTime: game.startTime,
    endTime: game.endTime,
    entryCount: game.submissions.length,
    prizePool: (game.submissions.length * 0.05).toFixed(2),
    timeRemaining: Math.max(0, game.endTime - Date.now()),
    finalized: game.finalized,
    started: true,
    status: game.finalized ? 'finalized' : 'active'
  };
});

// Get payment intent for entry
app.post('/api/pay', async (request, reply) => {
  const { walletAddress } = request.body as { walletAddress: string };
  
  const game = games.get(currentGameId);
  if (!game || Date.now() > game.endTime) {
    return reply.status(400).send({ error: 'No active game' });
  }

  // Check if already entered
  const alreadyEntered = game.submissions.some(
    s => s.playerAddress.toLowerCase() === walletAddress.toLowerCase()
  );
  
  if (alreadyEntered) {
    return reply.status(400).send({ error: 'Already entered this game' });
  }

  if (!paymentService) {
    return reply.status(500).send({ error: 'Payment service not available' });
  }

  const paymentIntent = paymentService.createPaymentIntent(currentGameId, walletAddress);
  const headers = paymentService.generateX402Headers(paymentIntent);

  return {
    paymentIntent,
    x402Headers: headers,
    instructions: {
      step1: `Approve USDC spending for ${paymentIntent.recipientAddress}`,
      step2: `Transfer ${paymentIntent.amount} USDC to ${paymentIntent.recipientAddress}`,
      step3: 'Submit the transaction hash with your artwork'
    }
  };
});

// Submit artwork
app.post('/api/submit', async (request, reply) => {
  const parsed = SubmitSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Invalid request', details: parsed.error });
  }

  const { imageUrl, title, walletAddress, paymentTxHash } = parsed.data;
  
  // Get latest active game
  let gameId = currentGameId || 1;
  if (process.env.DATABASE_URL) {
    try {
      gameId = await db.getLatestGameId();
      const gameData = await db.getOrCreateGame(gameId);
      // If game is finalized, create new one
      if (gameData.finalized) {
        gameId = await db.createNextGame();
      }
      currentGameId = gameId;
    } catch (e) {
      console.log('Error getting latest game:', e);
    }
  }

  // Verify payment
  if (!paymentService) {
    return reply.status(500).send({ error: 'Payment service not available' });
  }
  
  const verification = await paymentService.verifyPayment(paymentTxHash as `0x${string}`);
  if (!verification.valid) {
    return reply.status(402).send({ 
      error: 'Payment verification failed', 
      details: verification.error 
    });
  }

  // Try database first
  try {
    if (process.env.DATABASE_URL) {
      // Check if already entered
      const alreadyEntered = await db.hasPlayerEntered(gameId, walletAddress);
      if (alreadyEntered) {
        return reply.status(400).send({ error: 'Already entered this game' });
      }

      // Get current game state
      const gameData = await db.getOrCreateGame(gameId);
      
      // Check if game has ended (but not finalized yet)
      if (gameData.started && gameData.endTime > 0 && Date.now() > gameData.endTime) {
        return reply.status(400).send({ error: 'Game has ended, wait for next round' });
      }

      // Add to database
      const entry = await db.addEntry(gameId, imageUrl, title, walletAddress, paymentTxHash);
      await db.updateGamePrizePool(gameId, '0.05');

      // If this is the first entry, start the 6-hour timer!
      const entries = await db.getEntriesForGame(gameId);
      if (entries.length === 1 && !gameData.started) {
        const { endTime } = await db.startGameTimer(gameId);
        console.log(`🎯 First entry received! Game #${gameId} ends at ${new Date(endTime).toISOString()}`);
      }

      return {
        success: true,
        submission: {
          id: entry.id,
          title: title,
          position: entries.length
        },
        gameStarted: entries.length === 1
      };
    }
  } catch (e) {
    console.log('Database error, using in-memory:', e);
  }

  // Fallback to in-memory
  const game = games.get(currentGameId);
  if (!game || Date.now() > game.endTime) {
    return reply.status(400).send({ error: 'No active game' });
  }

  // Check if already entered
  const alreadyEntered = game.submissions.some(
    s => s.playerAddress.toLowerCase() === walletAddress.toLowerCase()
  );
  
  if (alreadyEntered) {
    return reply.status(400).send({ error: 'Already entered this game' });
  }

  // Create submission
  const submission: Submission = {
    id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    gameId: currentGameId,
    imageUrl,
    title,
    playerAddress: walletAddress,
    timestamp: Date.now(),
    paymentTxHash
  };

  game.submissions.push(submission);

  // Also add to automation storage
  if (!entriesForAutomation.has(currentGameId)) {
    entriesForAutomation.set(currentGameId, game.submissions);
  }

  return {
    success: true,
    submission: {
      id: submission.id,
      title: submission.title,
      position: game.submissions.length
    }
  };
});

// Get leaderboard
app.get('/api/leaderboard', async () => {
  const gameId = currentGameId || 1;

  // Try database first
  try {
    if (process.env.DATABASE_URL) {
      const entries = await db.getEntriesForGame(gameId);
      return {
        gameId: gameId,
        entries: entries.map((e, i) => ({
          position: i + 1,
          title: e.title,
          imageUrl: e.imageUrl,
          playerAddress: e.playerAddress,
          submittedAt: e.submittedAt,
          isWinner: e.isWinner
        })),
        finalized: false
      };
    }
  } catch (e) {
    console.log('Database error, using in-memory');
  }

  const game = games.get(currentGameId);
  if (!game) {
    return { entries: [], gameId: null };
  }

  return {
    gameId: game.id,
    entries: game.submissions.map((s, i) => ({
      position: i + 1,
      title: s.title,
      imageUrl: s.imageUrl,
      playerAddress: `${s.playerAddress.slice(0, 6)}...${s.playerAddress.slice(-4)}`,
      submittedAt: s.timestamp
    })),
    finalized: game.finalized,
    winnerId: game.winnerId
  };
});

// Get history of past games
app.get('/api/history', async () => {
  try {
    if (process.env.DATABASE_URL) {
      const pastGames = await db.getPastGames(10);
      const stats = await db.getStats();
      return {
        games: pastGames,
        stats
      };
    }
  } catch (e) {
    console.log('Database error:', e);
  }

  return {
    games: [],
    stats: { totalGames: 0, totalEntries: 0, totalPrizeDistributed: '0', uniquePlayers: 0 }
  };
});

// Get entries for a specific game
app.get('/api/game/:gameId/entries', async (request) => {
  const { gameId } = request.params as { gameId: string };
  
  try {
    if (process.env.DATABASE_URL) {
      const entries = await db.getAllEntriesForGame(parseInt(gameId));
      return { entries };
    }
  } catch (e) {
    console.log('Database error:', e);
  }

  return { entries: [] };
});

// ============ Admin Routes ============

// Start new game (admin only)
app.post('/api/admin/start-game', async (request, reply) => {
  const { duration = 24 * 60 * 60 * 1000 } = request.body as { duration?: number };
  
  // Finalize previous game if exists
  const previousGame = games.get(currentGameId);
  if (previousGame && !previousGame.finalized && previousGame.submissions.length > 0) {
    return reply.status(400).send({ error: 'Previous game not finalized' });
  }

  currentGameId++;
  const game: Game = {
    id: currentGameId,
    startTime: Date.now(),
    endTime: Date.now() + duration,
    submissions: [],
    finalized: false
  };

  games.set(currentGameId, game);

  return {
    success: true,
    game: {
      id: game.id,
      startTime: game.startTime,
      endTime: game.endTime
    }
  };
});

// Finalize game and pick winner (admin only)
app.post('/api/admin/finalize', async (request, reply) => {
  const game = games.get(currentGameId);
  if (!game) {
    return reply.status(400).send({ error: 'No game to finalize' });
  }

  if (game.finalized) {
    return reply.status(400).send({ error: 'Game already finalized' });
  }

  if (game.submissions.length === 0) {
    return reply.status(400).send({ error: 'No submissions to judge' });
  }

  if (!aiJudge) {
    return reply.status(500).send({ error: 'AI Judge service not available' });
  }

  // Judge submissions
  const result = await aiJudge.judgeSubmissions(
    game.submissions.map(s => ({
      id: s.id,
      imageUrl: s.imageUrl,
      title: s.title,
      playerAddress: s.playerAddress,
      timestamp: s.timestamp
    }))
  );

  game.finalized = true;
  game.winnerId = result.winnerId;

  // Find winner submission
  const winner = game.submissions.find(s => s.id === result.winnerId);

  return {
    success: true,
    result: {
      winnerId: result.winnerId,
      winnerAddress: winner?.playerAddress,
      winnerScore: result.winnerScore,
      scores: result.scores,
      judgedAt: result.judgedAt
    }
  };
});

// Auto-finalize game (for automation)
app.post('/api/admin/auto-finalize', async (request, reply) => {
  console.log('🤖 Auto-finalize triggered via API');
  
  const result = await manualFinalize();
  
  if (result.success) {
    // Start new game automatically
    currentGameId++;
    games.set(currentGameId, {
      id: currentGameId,
      startTime: Date.now(),
      endTime: Date.now() + 24 * 60 * 60 * 1000,
      submissions: [],
      finalized: false
    });
    
    return {
      success: true,
      ...result,
      newGameId: currentGameId
    };
  }
  
  return reply.status(400).send(result);
});

// Get automation status
app.get('/api/admin/status', async () => {
  const game = games.get(currentGameId);
  return {
    currentGameId,
    gameStatus: game ? {
      submissions: game.submissions.length,
      finalized: game.finalized,
      timeRemaining: Math.max(0, game.endTime - Date.now()),
      endsAt: new Date(game.endTime).toISOString()
    } : null,
    cronEnabled: true,
    nextFinalization: '00:00 UTC daily'
  };
});

// ============ Start Server ============

const start = async () => {
  try {
    // Initialize database and get current game
    if (process.env.DATABASE_URL) {
      try {
        await db.initDatabase();
        console.log('✅ PostgreSQL database connected');
        
        // Get or create game 1
        const gameData = await db.getOrCreateGame(1);
        currentGameId = gameData.gameId;
        console.log(`📊 Current game: #${currentGameId} (${gameData.started ? 'active' : 'waiting for entries'})`);
      } catch (e) {
        console.log('⚠️ Database initialization failed, using in-memory storage:', e);
        currentGameId = 1;
      }
    } else {
      console.log('⚠️ DATABASE_URL not set - using in-memory storage (data will be lost on restart)');
      currentGameId = 1;
    }

    // In-memory fallback
    games.set(1, {
      id: 1,
      startTime: Date.now(),
      endTime: 0, // Not started yet
      submissions: [],
      finalized: false
    });

    // Link entries storage for automation
    entriesForAutomation.set(1, games.get(1)!.submissions);
    setEntriesStorage(entriesForAutomation);

    // Start cron scheduler for automatic daily finalization
    startCronScheduler();

    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🎨 AI Art Arena backend running on port ${PORT}`);
    console.log(`📊 Current game: #${currentGameId}`);
    console.log(`⏰ Auto-finalization: Daily at 00:00 UTC`);
    console.log(`💾 Storage: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'In-memory'}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
