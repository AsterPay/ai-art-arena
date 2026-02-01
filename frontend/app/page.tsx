'use client';

import { useState, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import SubmitModal from '../components/SubmitModal';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const PRIZE_POOL_ADDRESS = process.env.NEXT_PUBLIC_PRIZE_POOL_ADDRESS || '0x0000000000000000000000000000000000000000';

interface GameInfo {
  gameId: number;
  startTime: number;
  endTime: number;
  entryCount: number;
  prizePool: string;
  timeRemaining: number;
  finalized: boolean;
  started: boolean;
  status: 'waiting' | 'active' | 'ended' | 'finalized';
}

interface LeaderboardEntry {
  position: number;
  title: string;
  imageUrl: string;
  playerAddress: string;
  submittedAt: number;
  isWinner?: boolean;
  scoreTotal?: number;
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const [game, setGame] = useState<GameInfo | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeLeft, setTimeLeft] = useState('');
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [selectedImage, setSelectedImage] = useState<LeaderboardEntry | null>(null);

  const handleSubmitSuccess = () => {
    fetch(`${API_URL}/api/leaderboard`)
      .then(res => res.json())
      .then(data => setLeaderboard(data.entries || []));
  };

  // Fetch game info
  useEffect(() => {
    const fetchGame = async () => {
      try {
        const res = await fetch(`${API_URL}/api/game`);
        const data = await res.json();
        setGame(data);
      } catch (err) {
        console.error('Failed to fetch game:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchGame();
    const interval = setInterval(fetchGame, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch leaderboard
  useEffect(() => {
    const fetchLeaderboard = async () => {
      try {
        const res = await fetch(`${API_URL}/api/leaderboard`);
        const data = await res.json();
        setLeaderboard(data.entries || []);
      } catch (err) {
        console.error('Failed to fetch leaderboard:', err);
      }
    };

    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 10000);
    return () => clearInterval(interval);
  }, []);

  // Countdown timer
  useEffect(() => {
    const updateTimer = () => {
      if (!game) return;
      
      // If game not started yet, show waiting message
      if (!game.started || game.status === 'waiting') {
        setTimeLeft('Waiting for first entry');
        return;
      }
      
      // If game finalized
      if (game.finalized || game.status === 'finalized') {
        setTimeLeft('Winner announced!');
        return;
      }
      
      // If game ended but not finalized
      if (game.status === 'ended') {
        setTimeLeft('Judging...');
        return;
      }

      const remaining = game.endTime - Date.now();
      if (remaining <= 0) {
        setTimeLeft('Judging...');
        return;
      }

      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

      setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [game]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50">
      {/* Header */}
      <header className="border-b border-purple-200 bg-white/70 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-xl shadow-lg shadow-purple-200">
              🎨
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">AI Art Arena</h1>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-600 border border-purple-200">
                  x402
                </span>
                <span className="text-xs text-purple-500">Base</span>
              </div>
            </div>
          </div>
          <ConnectButton />
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-5xl md:text-6xl font-bold mb-4 animate-fade-in">
            <span className="text-gray-800">Daily AI Art </span>
            <span className="bg-gradient-to-r from-purple-600 via-pink-500 to-indigo-600 bg-clip-text text-transparent">
              Competition
            </span>
          </h2>
          <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">
            Submit your AI-generated art. Pay $0.05 to enter. 
            <br />Competition runs <span className="text-purple-600 font-semibold">6 hours</span> from first entry.
            <br />Winner takes <span className="text-green-600 font-semibold">90%</span> of the prize pool.
          </p>

          {/* Game Stats */}
          <div className="grid grid-cols-3 gap-4 max-w-xl mx-auto mb-10">
            <div className="p-5 rounded-2xl bg-white shadow-lg shadow-purple-100 border border-purple-100">
              <div className="text-3xl md:text-4xl font-bold text-gray-800 mb-1">
                ${game?.prizePool || '0'}
              </div>
              <div className="text-sm text-purple-500">Prize Pool</div>
            </div>
            <div className="p-5 rounded-2xl bg-white shadow-lg shadow-green-100 border border-green-100">
              <div className="text-3xl md:text-4xl font-bold text-gray-800 mb-1">
                {game?.entryCount || 0}
              </div>
              <div className="text-sm text-green-500">Entries</div>
            </div>
            <div className="p-5 rounded-2xl bg-white shadow-lg shadow-orange-100 border border-orange-100">
              <div className="text-xl md:text-2xl font-bold text-gray-800 mb-1">
                {timeLeft || '--:--:--'}
              </div>
              <div className="text-sm text-orange-500">Time Left</div>
            </div>
          </div>

          {/* CTA */}
          {isConnected ? (
            <button 
              onClick={() => setShowSubmitModal(true)}
              className="group px-8 py-4 rounded-2xl font-bold text-lg text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-xl shadow-purple-200 hover:shadow-purple-300 transition-all duration-300 hover:scale-105"
            >
              <span className="flex items-center gap-2">
                <span className="text-2xl">🎨</span>
                <span>Submit Your Art — $0.05</span>
              </span>
            </button>
          ) : (
            <div className="text-gray-500 text-lg">
              Connect your wallet to participate
            </div>
          )}
        </div>
      </section>

      {/* How It Works */}
      <section className="py-16 px-4 bg-white/50">
        <div className="max-w-5xl mx-auto">
          <h3 className="text-2xl font-bold text-gray-800 text-center mb-10">
            How It Works
          </h3>
          <div className="grid md:grid-cols-4 gap-5">
            {[
              { icon: '💳', title: 'Pay $0.05', desc: 'Entry fee via x402 (USDC)', color: 'purple' },
              { icon: '🖼️', title: 'Submit Art', desc: 'Upload your AI creation', color: 'blue' },
              { icon: '🤖', title: 'AI Judges', desc: 'Claude evaluates all entries', color: 'pink' },
              { icon: '🏆', title: 'Win 90%', desc: 'Daily winner takes the pool', color: 'amber' },
            ].map((step, i) => (
              <div 
                key={i}
                className="p-6 rounded-2xl text-center bg-white shadow-lg border border-gray-100 hover:shadow-xl hover:border-purple-200 transition-all duration-300"
              >
                <div className="text-4xl mb-3">{step.icon}</div>
                <h4 className="font-semibold text-gray-800 mb-1">{step.title}</h4>
                <p className="text-sm text-gray-500">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Leaderboard */}
      <section className="py-16 px-4">
        <div className="max-w-5xl mx-auto">
          <h3 className="text-2xl font-bold text-gray-800 text-center mb-10">
            Today's Entries
          </h3>
          
          {leaderboard.length === 0 ? (
            <div className="text-center py-16 rounded-2xl bg-white/70 border-2 border-dashed border-purple-200">
              <div className="text-5xl mb-4">🎨</div>
              <p className="text-gray-500 text-lg">No entries yet. Be the first!</p>
            </div>
          ) : (
            <div className="grid md:grid-cols-3 gap-5">
              {leaderboard.map((entry, i) => (
                <div 
                  key={i}
                  className="rounded-2xl overflow-hidden bg-white shadow-lg border border-gray-100 hover:shadow-xl transition-all duration-300"
                >
                  <div 
                    className="aspect-square bg-gradient-to-br from-purple-100 to-pink-100 relative cursor-pointer group"
                    onClick={() => setSelectedImage(entry)}
                  >
                    <img 
                      src={entry.imageUrl} 
                      alt={entry.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                      <span className="opacity-0 group-hover:opacity-100 text-white text-2xl transition-opacity">🔍</span>
                    </div>
                    <div className="absolute top-3 right-3 w-10 h-10 rounded-full bg-white shadow-lg flex items-center justify-center text-xl">
                      {entry.isWinner ? '🏆' : i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                    </div>
                    {entry.isWinner && (
                      <div className="absolute bottom-3 left-3 px-3 py-1 rounded-full bg-yellow-400 text-yellow-900 text-xs font-bold shadow-lg">
                        WINNER!
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <h4 className="font-semibold text-gray-800 truncate">{entry.title}</h4>
                    <p className="text-sm text-gray-400 truncate">{entry.playerAddress}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-purple-100 py-10 px-4 bg-white/50">
        <div className="max-w-5xl mx-auto text-center">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-gray-500">Powered by</span>
            <span className="font-bold text-purple-600">AsterPay x402</span>
          </div>
          <p className="text-sm text-gray-400">
            AI Art Arena is a demonstration of x402 micropayments.{' '}
            <a href="https://asterpay.io" className="text-purple-500 hover:text-purple-600 transition-colors">
              Build your own →
            </a>
          </p>
        </div>
      </footer>

      {/* Submit Modal */}
      <SubmitModal 
        isOpen={showSubmitModal}
        onClose={() => setShowSubmitModal(false)}
        onSuccess={handleSubmitSuccess}
        prizePoolAddress={PRIZE_POOL_ADDRESS}
      />

      {/* Image Lightbox */}
      {selectedImage && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
          onClick={() => setSelectedImage(null)}
        >
          <div 
            className="relative max-w-4xl max-h-[90vh] w-full animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSelectedImage(null)}
              className="absolute -top-12 right-0 text-white hover:text-gray-300 transition-colors"
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <img 
              src={selectedImage.imageUrl} 
              alt={selectedImage.title}
              className="w-full h-auto max-h-[80vh] object-contain rounded-2xl shadow-2xl"
            />
            <div className="mt-4 text-center">
              <h3 className="text-xl font-bold text-white">{selectedImage.title}</h3>
              <p className="text-gray-400 text-sm mt-1">by {selectedImage.playerAddress.slice(0, 6)}...{selectedImage.playerAddress.slice(-4)}</p>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
