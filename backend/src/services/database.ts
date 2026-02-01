import { Pool } from 'pg';

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
export async function initDatabase(): Promise<void> {
  console.log('📦 Initializing database...');
  
  try {
    // Create games table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        game_id INTEGER UNIQUE NOT NULL,
        start_time BIGINT NOT NULL,
        end_time BIGINT NOT NULL DEFAULT 0,
        prize_pool DECIMAL(20, 6) DEFAULT 0,
        entry_count INTEGER DEFAULT 0,
        started BOOLEAN DEFAULT FALSE,
        finalized BOOLEAN DEFAULT FALSE,
        winner_address VARCHAR(42),
        winner_title VARCHAR(255),
        winner_score INTEGER,
        winner_image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add started column if it doesn't exist (migration for existing tables)
    await pool.query(`
      ALTER TABLE games ADD COLUMN IF NOT EXISTS started BOOLEAN DEFAULT FALSE
    `);

    // Create entries table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS entries (
        id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        title VARCHAR(255) NOT NULL,
        player_address VARCHAR(42) NOT NULL,
        payment_tx_hash VARCHAR(66) NOT NULL,
        score_creativity INTEGER,
        score_technique INTEGER,
        score_theme INTEGER,
        score_total INTEGER,
        reasoning TEXT,
        is_winner BOOLEAN DEFAULT FALSE,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(game_id, player_address)
      )
    `);

    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_entries_game_id ON entries(game_id)
    `);

    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

// Game duration: 6 hours (in milliseconds)
const GAME_DURATION_MS = 6 * 60 * 60 * 1000;

// Game operations
export async function getOrCreateGame(gameId: number): Promise<{
  gameId: number;
  startTime: number;
  endTime: number;
  prizePool: string;
  entryCount: number;
  finalized: boolean;
  started: boolean;
}> {
  // Try to get existing game
  const result = await pool.query(
    'SELECT * FROM games WHERE game_id = $1',
    [gameId]
  );

  if (result.rows.length > 0) {
    const game = result.rows[0];
    return {
      gameId: game.game_id,
      startTime: parseInt(game.start_time),
      endTime: parseInt(game.end_time),
      prizePool: game.prize_pool || '0',
      entryCount: game.entry_count || 0,
      finalized: game.finalized,
      started: game.started || false
    };
  }

  // Create new game (not started yet - waits for first entry)
  const now = Date.now();

  await pool.query(
    'INSERT INTO games (game_id, start_time, end_time, started) VALUES ($1, $2, $3, $4)',
    [gameId, now, 0, false]  // endTime = 0 means not started
  );

  return {
    gameId,
    startTime: now,
    endTime: 0,
    prizePool: '0',
    entryCount: 0,
    finalized: false,
    started: false
  };
}

// Start game timer when first entry arrives
export async function startGameTimer(gameId: number): Promise<{ startTime: number; endTime: number; updated: boolean }> {
  const now = Date.now();
  const endTime = now + GAME_DURATION_MS; // 6 hours from now

  const result = await pool.query(
    'UPDATE games SET start_time = $1, end_time = $2, started = TRUE WHERE game_id = $3 AND started = FALSE RETURNING end_time',
    [now, endTime, gameId]
  );

  if (result.rowCount && result.rowCount > 0) {
    console.log(`🎮 Game #${gameId} started! Ends at ${new Date(endTime).toISOString()}`);
    return { startTime: now, endTime, updated: true };
  } else {
    // Game was already started - fetch current end_time
    const existing = await pool.query('SELECT start_time, end_time FROM games WHERE game_id = $1', [gameId]);
    if (existing.rows.length > 0) {
      console.log(`⚠️ Game #${gameId} already started, current endTime: ${existing.rows[0].end_time}`);
      return { 
        startTime: parseInt(existing.rows[0].start_time), 
        endTime: parseInt(existing.rows[0].end_time),
        updated: false 
      };
    }
    return { startTime: now, endTime, updated: false };
  }
}

// Get active (not finalized) games that have ended
export async function getExpiredGames(): Promise<Array<{
  gameId: number;
  entryCount: number;
  prizePool: string;
}>> {
  const now = Date.now();
  const result = await pool.query(
    `SELECT game_id, entry_count, prize_pool 
     FROM games 
     WHERE finalized = FALSE 
       AND started = TRUE 
       AND end_time > 0 
       AND end_time < $1 
       AND entry_count > 0`,
    [now]
  );

  return result.rows.map(row => ({
    gameId: row.game_id,
    entryCount: row.entry_count || 0,
    prizePool: row.prize_pool || '0'
  }));
}

// Create next game (called after finalization)
export async function createNextGame(): Promise<number> {
  // Find highest game_id
  const result = await pool.query('SELECT MAX(game_id) as max_id FROM games');
  const nextGameId = (result.rows[0]?.max_id || 0) + 1;

  const now = Date.now();
  await pool.query(
    'INSERT INTO games (game_id, start_time, end_time, started) VALUES ($1, $2, $3, $4)',
    [nextGameId, now, 0, false]
  );

  console.log(`🆕 New game #${nextGameId} created (waiting for first entry)`);
  return nextGameId;
}

// Get latest game ID
export async function getLatestGameId(): Promise<number> {
  const result = await pool.query('SELECT MAX(game_id) as max_id FROM games');
  return result.rows[0]?.max_id || 1;
}

export async function updateGamePrizePool(gameId: number, amount: string): Promise<void> {
  await pool.query(
    'UPDATE games SET prize_pool = prize_pool + $1, entry_count = entry_count + 1 WHERE game_id = $2',
    [parseFloat(amount), gameId]
  );
}

export async function finalizeGame(
  gameId: number,
  winnerAddress: string,
  winnerTitle: string,
  winnerScore: number,
  winnerImageUrl: string
): Promise<void> {
  await pool.query(
    `UPDATE games SET 
      finalized = TRUE, 
      winner_address = $1, 
      winner_title = $2, 
      winner_score = $3,
      winner_image_url = $4
    WHERE game_id = $5`,
    [winnerAddress, winnerTitle, winnerScore, winnerImageUrl, gameId]
  );

  // Mark winner in entries
  await pool.query(
    'UPDATE entries SET is_winner = TRUE WHERE game_id = $1 AND player_address = $2',
    [gameId, winnerAddress]
  );
}

// Entry operations
export async function addEntry(
  gameId: number,
  imageUrl: string,
  title: string,
  playerAddress: string,
  paymentTxHash: string
): Promise<{ id: number }> {
  const result = await pool.query(
    `INSERT INTO entries (game_id, image_url, title, player_address, payment_tx_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [gameId, imageUrl, title, playerAddress.toLowerCase(), paymentTxHash]
  );
  
  return { id: result.rows[0].id };
}

export async function getEntriesForGame(gameId: number): Promise<Array<{
  id: number;
  imageUrl: string;
  title: string;
  playerAddress: string;
  submittedAt: number;
  scoreTotal?: number;
  isWinner: boolean;
}>> {
  const result = await pool.query(
    `SELECT id, image_url, title, player_address, submitted_at, score_total, is_winner
     FROM entries 
     WHERE game_id = $1 
     ORDER BY submitted_at DESC`,
    [gameId]
  );

  return result.rows.map(row => ({
    id: row.id,
    imageUrl: row.image_url,
    title: row.title,
    playerAddress: row.player_address,
    submittedAt: new Date(row.submitted_at).getTime(),
    scoreTotal: row.score_total,
    isWinner: row.is_winner
  }));
}

export async function hasPlayerEntered(gameId: number, playerAddress: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM entries WHERE game_id = $1 AND player_address = $2',
    [gameId, playerAddress.toLowerCase()]
  );
  return result.rows.length > 0;
}

export async function updateEntryScores(
  gameId: number,
  playerAddress: string,
  creativity: number,
  technique: number,
  theme: number,
  reasoning: string
): Promise<void> {
  const total = creativity + technique + theme;
  await pool.query(
    `UPDATE entries SET 
      score_creativity = $1, 
      score_technique = $2, 
      score_theme = $3, 
      score_total = $4,
      reasoning = $5
     WHERE game_id = $6 AND player_address = $7`,
    [creativity, technique, theme, total, reasoning, gameId, playerAddress.toLowerCase()]
  );
}

// History operations
export async function getPastGames(limit: number = 10): Promise<Array<{
  gameId: number;
  startTime: number;
  endTime: number;
  prizePool: string;
  entryCount: number;
  winnerAddress?: string;
  winnerTitle?: string;
  winnerScore?: number;
  winnerImageUrl?: string;
}>> {
  const result = await pool.query(
    `SELECT * FROM games 
     WHERE finalized = TRUE 
     ORDER BY game_id DESC 
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(row => ({
    gameId: row.game_id,
    startTime: parseInt(row.start_time),
    endTime: parseInt(row.end_time),
    prizePool: row.prize_pool || '0',
    entryCount: row.entry_count || 0,
    winnerAddress: row.winner_address,
    winnerTitle: row.winner_title,
    winnerScore: row.winner_score,
    winnerImageUrl: row.winner_image_url
  }));
}

export async function getAllEntriesForGame(gameId: number): Promise<Array<{
  id: number;
  imageUrl: string;
  title: string;
  playerAddress: string;
  submittedAt: number;
  scoreCreativity?: number;
  scoreTechnique?: number;
  scoreTheme?: number;
  scoreTotal?: number;
  reasoning?: string;
  isWinner: boolean;
}>> {
  const result = await pool.query(
    `SELECT * FROM entries 
     WHERE game_id = $1 
     ORDER BY score_total DESC NULLS LAST, submitted_at ASC`,
    [gameId]
  );

  return result.rows.map(row => ({
    id: row.id,
    imageUrl: row.image_url,
    title: row.title,
    playerAddress: row.player_address,
    submittedAt: new Date(row.submitted_at).getTime(),
    scoreCreativity: row.score_creativity,
    scoreTechnique: row.score_technique,
    scoreTheme: row.score_theme,
    scoreTotal: row.score_total,
    reasoning: row.reasoning,
    isWinner: row.is_winner
  }));
}

// Stats
export async function getStats(): Promise<{
  totalGames: number;
  totalEntries: number;
  totalPrizeDistributed: string;
  uniquePlayers: number;
}> {
  const gamesResult = await pool.query('SELECT COUNT(*) FROM games WHERE finalized = TRUE');
  const entriesResult = await pool.query('SELECT COUNT(*) FROM entries');
  const prizeResult = await pool.query('SELECT COALESCE(SUM(prize_pool), 0) as total FROM games WHERE finalized = TRUE');
  const playersResult = await pool.query('SELECT COUNT(DISTINCT player_address) FROM entries');

  return {
    totalGames: parseInt(gamesResult.rows[0].count),
    totalEntries: parseInt(entriesResult.rows[0].count),
    totalPrizeDistributed: prizeResult.rows[0].total || '0',
    uniquePlayers: parseInt(playersResult.rows[0].count)
  };
}

export default pool;
