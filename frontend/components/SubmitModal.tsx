'use client';

import { useState, useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, getAddress } from 'viem';
import ImageUpload from './ImageUpload';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// USDC on Base mainnet
const USDC_MAINNET = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const USDC_TESTNET = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const ENTRY_FEE = parseUnits('0.05', 6); // $0.05 USDC entry fee

// AsterPay wallet for receiving entry fees (direct transfer, no smart contract needed)
const ASTERPAY_WALLET = getAddress('0x3a649f923c7e74E5c22e766F8E0fA2CF7e627e71');

// Use mainnet in production, testnet in development
const IS_MAINNET = process.env.NEXT_PUBLIC_CHAIN_ID === '8453';
const USDC_ADDRESS = IS_MAINNET ? USDC_MAINNET : USDC_TESTNET;

interface SubmitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  prizePoolAddress: string;
}

type Step = 'upload' | 'pay' | 'submit' | 'success';

const STEPS = [
  { id: 'upload', label: 'Upload', icon: '📤' },
  { id: 'pay', label: 'Pay', icon: '💳' },
  { id: 'submit', label: 'Submit', icon: '🚀' },
];

export function SubmitModal({ isOpen, onClose, onSuccess, prizePoolAddress }: SubmitModalProps) {
  const { address } = useAccount();
  const [step, setStep] = useState<Step>('upload');
  const [title, setTitle] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  // USDC Transfer (direct to AsterPay wallet - no approve needed!)
  const { writeContract: transfer, data: transferHash, error: transferError } = useWriteContract();
  const { isLoading: isTransferring, isSuccess: isTransferred } = useWaitForTransactionReceipt({
    hash: transferHash,
  });

  // Log transfer errors
  useEffect(() => {
    if (transferError) {
      console.error('Transfer error:', transferError);
      setError(transferError.message || 'Transfer failed');
      setStep('upload');
    }
  }, [transferError]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setStep('upload');
      setTitle('');
      setImageUrl('');
      setError(null);
    }
  }, [isOpen]);

  const handleImageUpload = (url: string) => {
    setImageUrl(url);
    setError(null);
  };

  // Direct USDC transfer to AsterPay wallet (no approve needed!)
  const handlePay = async () => {
    setError(null);
    setStep('pay');
    try {
      console.log('Initiating USDC transfer to:', ASTERPAY_WALLET);
      transfer({
        address: USDC_ADDRESS,
        abi: [{
          name: 'transfer',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          outputs: [{ name: '', type: 'bool' }]
        }],
        functionName: 'transfer',
        args: [ASTERPAY_WALLET as `0x${string}`, ENTRY_FEE],
      });
    } catch (err) {
      console.error('Payment error:', err);
      setError(err instanceof Error ? err.message : 'Payment failed');
      setStep('upload');
    }
  };

  const handleSubmit = async () => {
    if (!transferHash || !address) return;
    
    setError(null);
    setStep('submit');

    try {
      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

      const response = await fetch(`${API_URL}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl,
          title,
          walletAddress: address,
          paymentTxHash: transferHash,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Submission failed');
      }

      setStep('success');
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1500); // Reduced from 2500ms
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Request timed out. Your payment was received - please refresh the page.');
      } else {
        setError(err instanceof Error ? err.message : 'Submission failed');
      }
      setStep('upload'); // Go back to upload so user can close
    }
  };

  // Auto-advance when payment confirmed
  useEffect(() => {
    if (isTransferred && step === 'pay') {
      handleSubmit();
    }
  }, [isTransferred, step]);

  const canProceed = title.trim().length > 0 && imageUrl.length > 0;
  const currentStepIndex = STEPS.findIndex(s => s.id === step);

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 pb-4 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-indigo-50">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-bold text-gray-800">Submit Your Art</h2>
              <p className="text-purple-600 text-sm mt-1">Entry fee: $0.05 USDC</p>
            </div>
            <button 
              onClick={onClose}
              className="w-10 h-10 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-colors"
            >
              <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Progress Steps */}
          <div className="flex items-center justify-between mt-6">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex items-center">
                <div className={`
                  w-10 h-10 rounded-full flex items-center justify-center text-lg
                  transition-all duration-300 shadow-sm
                  ${i < currentStepIndex ? 'bg-green-500 text-white' : ''}
                  ${i === currentStepIndex ? 'bg-purple-600 text-white ring-4 ring-purple-200' : ''}
                  ${i > currentStepIndex ? 'bg-gray-100 text-gray-400' : ''}
                `}>
                  {i < currentStepIndex ? '✓' : s.icon}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-12 h-1 mx-1 rounded transition-colors duration-300 ${
                    i < currentStepIndex ? 'bg-green-500' : 'bg-gray-200'
                  }`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {step === 'success' ? (
            <div className="text-center py-8 animate-scale-in">
              <div className="text-7xl mb-4">🎉</div>
              <h3 className="text-2xl font-bold text-gray-800 mb-2">Submission Complete!</h3>
              <p className="text-gray-500">Good luck in the competition!</p>
              <div className="mt-4 inline-block px-4 py-2 bg-green-100 rounded-full text-green-600 text-sm font-medium">
                Your entry is now live
              </div>
            </div>
          ) : (
            <>
              {/* Title Input */}
              <div className="mb-5">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Artwork Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Enter a creative title..."
                  className="w-full px-4 py-3 rounded-xl text-gray-800 placeholder-gray-400 bg-gray-50 border border-gray-200 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                  disabled={step !== 'upload'}
                />
              </div>

              {/* Image Upload */}
              <div className="mb-5">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your Artwork
                </label>
                <ImageUpload 
                  onUpload={handleImageUpload}
                  disabled={step !== 'upload'}
                  currentImage={imageUrl}
                />
              </div>

              {/* Error Message */}
              {error && (
                <div className="mb-5 p-4 rounded-xl text-red-600 text-sm bg-red-50 border border-red-200">
                  {error}
                </div>
              )}

              {/* Action Button */}
              <button
                onClick={step === 'upload' ? handlePay : undefined}
                disabled={!canProceed || step !== 'upload'}
                className={`
                  w-full py-4 rounded-xl font-bold text-lg transition-all duration-300
                  ${canProceed && step === 'upload'
                    ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-lg shadow-purple-200 hover:shadow-purple-300 hover:scale-[1.02]'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  }
                `}
              >
                {step === 'upload' && (
                  <span className="flex items-center justify-center gap-2">
                    <span>💳</span>
                    <span>Pay $0.05 & Submit</span>
                  </span>
                )}
                {step === 'pay' && (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Processing Payment...</span>
                  </span>
                )}
                {step === 'submit' && (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Submitting Entry...</span>
                  </span>
                )}
              </button>

              {/* Help Text */}
              <p className="text-center text-xs text-gray-400 mt-4">
                Powered by AsterPay x402 on Base
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SubmitModal;
