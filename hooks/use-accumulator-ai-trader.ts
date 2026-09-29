'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { analyzeAccumulatorMarket, type AccumulatorAiDecision } from '@/lib/ai-accumulator-engine';
import type { ActiveSymbol, BuyResult } from '@deriv/core';
import type { AccumulatorProposalInfo } from './use-accumulator-proposal';
import type { OpenPosition, GrowthRate } from '@/lib/types';

export type AiTradingMode = 'ai_only' | 'ai_assisted' | 'manual';

export interface AiTradeLog {
  id: string;
  timestamp: number;
  type: 'ENTRY' | 'EXIT' | 'SCAN' | 'ALERT';
  message: string;
  details?: string;
}

export interface UseAccumulatorAiTraderParams {
  activeSymbol: ActiveSymbol | null;
  proposal: AccumulatorProposalInfo | null;
  prices: number[];
  isConnected: boolean;
  isAuthenticated: boolean;
  activePosition: OpenPosition | null;
  buyContract: () => Promise<void>;
  isBuying: boolean;
  buyResult: BuyResult | null;
  buyError: string | null;
  sellContract?: (contractId: number, bidPrice: string) => Promise<void>;
  sellingId?: number | null;
  stake: string;
  growthRate: GrowthRate;
}

export function useAccumulatorAiTrader({
  activeSymbol,
  proposal,
  prices,
  isConnected,
  isAuthenticated,
  activePosition,
  buyContract,
  isBuying,
  buyResult,
  buyError,
  sellContract,
  sellingId,
  stake,
  growthRate,
}: UseAccumulatorAiTraderParams) {
  // Modes: 'ai_only' = all entries are evaluated and placed by AI;
  // 'ai_assisted' = AI analysis + 1-click AI entry + manual available;
  // 'manual' = manual entry only.
  const [aiMode, setAiMode] = useState<AiTradingMode>('ai_only');
  const [isAutoTrading, setIsAutoTrading] = useState<boolean>(true);
  const [minConfidence, setMinConfidence] = useState<number>(68);
  const [targetTicks, setTargetTicks] = useState<number>(4);
  const [autoExitOnTarget, setAutoExitOnTarget] = useState<boolean>(true);
  const [barrierShield, setBarrierShield] = useState<boolean>(true);

  const [aiDecision, setAiDecision] = useState<AccumulatorAiDecision | null>(null);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [aiLogs, setAiLogs] = useState<AiTradeLog[]>([]);
  const [tradesCount, setTradesCount] = useState<number>(0);

  const cooldownUntilRef = useRef<number>(0);
  const isAutoTradingRef = useRef(isAutoTrading);
  isAutoTradingRef.current = isAutoTrading;
  const isBuyingRef = useRef(isBuying);
  isBuyingRef.current = isBuying;
  const isExecutingRef = useRef(isExecuting);
  isExecutingRef.current = isExecuting;
  const activePositionRef = useRef(activePosition);
  activePositionRef.current = activePosition;

  const addLog = useCallback((type: AiTradeLog['type'], message: string, details?: string) => {
    setAiLogs((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        type,
        message,
        details,
      },
      ...prev.slice(0, 49),
    ]);
  }, []);

  // Real-time market evaluation via server-side Gemini API or local math engine
  const evaluateMarket = useCallback(async (): Promise<AccumulatorAiDecision | null> => {
    if (!activeSymbol) return null;
    const ticks = prices.map((price, idx) => ({
      quote: price,
      epoch: Math.floor(Date.now() / 1000) - prices.length + idx,
    }));

    const spot = prices[prices.length - 1] || 0;
    const highBarrier = proposal?.highBarrier;
    const lowBarrier = proposal?.lowBarrier;
    const barrierPercentage = proposal?.barrierPercentage;
    const hasCrossedBarrier = proposal?.hasCrossedBarrier ?? false;

    // First generate instant local deterministic stats
    const local = analyzeAccumulatorMarket({
      symbol: activeSymbol.underlying_symbol,
      spot,
      ticks,
      highBarrier,
      lowBarrier,
      barrierPercentage,
      hasCrossedBarrier,
      growthRate,
    });

    setIsEvaluating(true);
    try {
      const res = await fetch('/api/ai-scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: activeSymbol.underlying_symbol,
          spot,
          ticks: ticks.slice(-30),
          highBarrier,
          lowBarrier,
          barrierPercentage,
          hasCrossedBarrier,
          growthRate,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as AccumulatorAiDecision;
        setAiDecision(data);
        return data;
      }
    } catch {
      // Fallback to local
    } finally {
      setIsEvaluating(false);
    }

    setAiDecision(local);
    return local;
  }, [activeSymbol, prices, proposal, growthRate]);

  // Execute AI Entry
  const executeAiEntry = useCallback(
    async (force = false): Promise<boolean> => {
      if (!isConnected) {
        toast.error('Cannot place trade: Deriv WebSocket not connected');
        return false;
      }
      if (!isAuthenticated) {
        toast.error('Please log in with Deriv to place trades');
        return false;
      }
      if (activePositionRef.current) {
        toast.info('Accumulator position already active. Deriv allows 1 contract at a time.');
        return false;
      }
      if (isBuyingRef.current || isExecutingRef.current) {
        return false;
      }
      if (!proposal) {
        toast.error('Awaiting accumulator contract proposal from Deriv...');
        return false;
      }
      if (proposal.hasCrossedBarrier) {
        toast.error('Cannot enter: Spot has breached accumulator barrier. Wait for reset.');
        return false;
      }

      setIsExecuting(true);
      try {
        let decision = aiDecision;
        if (!decision || force) {
          decision = await evaluateMarket();
        }

        if (!force && decision) {
          if (decision.entryDecision !== 'ENTER') {
            addLog(
              'ALERT',
              `AI Entry Aborted: ${decision.rationale || 'Conditions not met'}`,
              `Confidence: ${decision.confidence}%, Barrier Safety: ${decision.barrierSafety}`
            );
            toast.warning('AI advises to WAIT', { description: decision.rationale });
            return false;
          }
          if (decision.confidence < minConfidence) {
            addLog(
              'ALERT',
              `AI Confidence (${decision.confidence}%) is below minimum threshold (${minConfidence}%)`,
              decision.rationale
            );
            toast.warning(`AI Confidence ${decision.confidence}% is below threshold (${minConfidence}%)`);
            return false;
          }
        }

        addLog(
          'ENTRY',
          `AI Placing Accumulator Entry on ${activeSymbol?.underlying_symbol_name || activeSymbol?.underlying_symbol || 'Accumulator'}`,
          `Stake: $${stake} | Growth: ${(growthRate * 100).toFixed(0)}% | Confidence: ${decision?.confidence ?? 85}% | Target: ${targetTicks} ticks`
        );

        toast.info('AI Engine placing Accumulator entry...', {
          description: `Targeting ${targetTicks} ticks with ${(growthRate * 100).toFixed(0)}% growth rate`,
        });

        await buyContract();
        setTradesCount((c) => c + 1);
        cooldownUntilRef.current = Date.now() + 3000;
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Trade placement failed';
        addLog('ALERT', 'AI Trade Entry Failed', msg);
        return false;
      } finally {
        setIsExecuting(false);
      }
    },
    [
      isConnected,
      isAuthenticated,
      proposal,
      aiDecision,
      evaluateMarket,
      minConfidence,
      activeSymbol,
      stake,
      growthRate,
      targetTicks,
      buyContract,
      addLog,
    ]
  );

  // Periodic AI Evaluation on incoming ticks
  useEffect(() => {
    if (!isConnected || !activeSymbol || prices.length < 5) return;
    const timer = setTimeout(() => {
      void evaluateMarket();
    }, 400);
    return () => clearTimeout(timer);
  }, [prices.length, isConnected, activeSymbol, evaluateMarket]);

  // Autonomous AI Trading Loop
  useEffect(() => {
    if (aiMode === 'manual') return;
    if (!isAutoTrading) return;
    if (!isConnected || !isAuthenticated) return;
    if (activePosition) return;
    if (isBuying || isExecuting) return;
    if (!proposal || proposal.hasCrossedBarrier) return;
    if (Date.now() < cooldownUntilRef.current) return;

    if (
      aiDecision &&
      aiDecision.entryDecision === 'ENTER' &&
      aiDecision.confidence >= minConfidence &&
      aiDecision.barrierSafety === 'SAFE'
    ) {
      // Trigger autonomous AI entry!
      void executeAiEntry(false);
    }
  }, [
    aiMode,
    isAutoTrading,
    isConnected,
    isAuthenticated,
    activePosition,
    isBuying,
    isExecuting,
    proposal,
    aiDecision,
    minConfidence,
    executeAiEntry,
  ]);

  // AI Active Contract Protection & Smart Exit
  const lastSoldContractIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!activePosition || !sellContract || !isConnected) return;
    if (sellingId === activePosition.contract_id) return;
    if (lastSoldContractIdRef.current === activePosition.contract_id) return;

    const tickCount = activePosition.tick_count ?? 0;

    // 1. Target Ticks Auto-Exit
    if (autoExitOnTarget && tickCount >= targetTicks && activePosition.is_valid_to_sell) {
      lastSoldContractIdRef.current = activePosition.contract_id;
      addLog(
        'EXIT',
        `AI Take-Profit Exit Triggered (${tickCount} ticks achieved)`,
        `Profit: +${parseFloat(activePosition.profit).toFixed(2)} ${activePosition.currency} | Return: ${(
          parseFloat(activePosition.buy_price) + parseFloat(activePosition.profit)
        ).toFixed(2)}`
      );
      toast.success(`AI Take-Profit Executed!`, {
        description: `Target of ${targetTicks} ticks reached. Secured +${parseFloat(
          activePosition.profit
        ).toFixed(2)} ${activePosition.currency}!`,
      });
      void sellContract(activePosition.contract_id, activePosition.bid_price);
      cooldownUntilRef.current = Date.now() + 3500;
      return;
    }

    // 2. Barrier Shield Emergency Protection
    if (barrierShield && activePosition.is_valid_to_sell) {
      if (proposal?.hasCrossedBarrier) {
        lastSoldContractIdRef.current = activePosition.contract_id;
        addLog('ALERT', 'AI Barrier Shield: Emergency sell triggered due to imminent barrier hazard');
        toast.warning('AI Barrier Shield: Closing position to preserve capital!');
        void sellContract(activePosition.contract_id, activePosition.bid_price);
        cooldownUntilRef.current = Date.now() + 4000;
      }
    }
  }, [
    activePosition,
    sellContract,
    isConnected,
    sellingId,
    autoExitOnTarget,
    targetTicks,
    barrierShield,
    proposal,
    addLog,
  ]);

  // Notify on buy success / error
  useEffect(() => {
    if (buyResult) {
      addLog(
        'ENTRY',
        `Accumulator Contract Active #${buyResult.contractId}`,
        `Buy Price: $${buyResult.buyPrice.toFixed(2)} | Balance: $${buyResult.balanceAfter.toFixed(2)}`
      );
    }
  }, [buyResult, addLog]);

  useEffect(() => {
    if (buyError) {
      addLog('ALERT', `Contract Entry Rejected`, buyError);
    }
  }, [buyError, addLog]);

  // Overall status
  const status: 'IDLE' | 'SCANNING' | 'READY' | 'PLACING_ENTRY' | 'POSITION_RUNNING' | 'COOLING_DOWN' =
    isExecuting || isBuying
      ? 'PLACING_ENTRY'
      : activePosition
      ? 'POSITION_RUNNING'
      : Date.now() < cooldownUntilRef.current
      ? 'COOLING_DOWN'
      : isEvaluating
      ? 'SCANNING'
      : aiDecision?.entryDecision === 'ENTER'
      ? 'READY'
      : 'SCANNING';

  return {
    aiMode,
    setAiMode,
    isAutoTrading,
    setIsAutoTrading,
    minConfidence,
    setMinConfidence,
    targetTicks,
    setTargetTicks,
    autoExitOnTarget,
    setAutoExitOnTarget,
    barrierShield,
    setBarrierShield,
    status,
    aiDecision,
    isEvaluating,
    isExecuting,
    aiLogs,
    tradesCount,
    evaluateMarket,
    executeAiEntry,
    clearLogs: () => setAiLogs([]),
  };
}

export type UseAccumulatorAiTraderReturn = ReturnType<typeof useAccumulatorAiTrader>;
