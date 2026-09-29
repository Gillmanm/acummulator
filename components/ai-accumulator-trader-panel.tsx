'use client';

import { useState } from 'react';
import {
  BrainCircuit,
  Sparkles,
  ShieldCheck,
  Zap,
  Target,
  ChevronDown,
  ChevronUp,
  Activity,
  History,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { UseAccumulatorAiTraderReturn, AiTradingMode } from '@/hooks/use-accumulator-ai-trader';
import type { OpenPosition } from '@/lib/types';
import type { AccumulatorProposalInfo } from '@/hooks/use-accumulator-proposal';

interface AiAccumulatorTraderPanelProps {
  trader: UseAccumulatorAiTraderReturn;
  activePosition?: OpenPosition | null;
  proposal: AccumulatorProposalInfo | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  stake: string;
  growthRate: number;
}

export function AiAccumulatorTraderPanel({
  trader,
  activePosition,
  proposal,
  isConnected,
  isAuthenticated,
  stake,
  growthRate,
}: AiAccumulatorTraderPanelProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const {
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
    executeAiEntry,
  } = trader;

  const confidence = aiDecision?.confidence ?? 0;
  const isReady = aiDecision?.entryDecision === 'ENTER' && confidence >= minConfidence;
  const barrierSafety = aiDecision?.barrierSafety ?? 'SAFE';

  // Status color badges
  const getStatusBadge = () => {
    if (activePosition) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-blue-600 dark:text-blue-400 border border-blue-500/30 animate-pulse">
          <Activity className="h-3 w-3" />
          Active: {activePosition.tick_count ?? 0}/{targetTicks} Ticks
        </span>
      );
    }
    if (status === 'PLACING_ENTRY') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400 border border-amber-500/30 animate-pulse">
          <Zap className="h-3 w-3" />
          Placing Entry...
        </span>
      );
    }
    if (status === 'COOLING_DOWN') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground border border-border">
          Cooling Down
        </span>
      );
    }
    if (isReady) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
          <Sparkles className="h-3 w-3" />
          AI Entry Ready ({confidence}%)
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground border border-border">
        {isEvaluating ? 'Evaluating Ticks...' : 'Monitoring Channel'}
      </span>
    );
  };

  return (
    <div className="rounded-xl border border-primary/25 bg-gradient-to-b from-card to-card/90 p-3.5 sm:p-4 shadow-sm space-y-3">
      {/* Top Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20">
            <BrainCircuit className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
                AI Accumulator Trader
              </h3>
              {aiMode === 'ai_only' && (
                <span className="rounded bg-primary px-1.5 py-0.2 text-[9px] font-bold text-primary-foreground">
                  AI ONLY
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">Deriv Accumulator Entry & Exit Engine</p>
          </div>
        </div>
        <div>{getStatusBadge()}</div>
      </div>

      {/* Mode Switcher */}
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1 border border-border/40 text-xs font-semibold">
        {(
          [
            { id: 'ai_only', label: 'AI ONLY', icon: Lock },
            { id: 'ai_assisted', label: 'AI Assisted', icon: Sparkles },
            { id: 'manual', label: 'Manual', icon: Activity },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setAiMode(id as AiTradingMode)}
            className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 transition-all ${
              aiMode === id
                ? 'bg-background text-foreground shadow-sm font-bold border border-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3 w-3" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {aiMode === 'ai_only' && (
        <div className="rounded-lg bg-primary/10 border border-primary/20 p-2.5 text-xs text-foreground flex items-start gap-2">
          <Lock className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-primary">AI-Only Entry Mode Active</span>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Manual buy is locked. All accumulator entries are placed and managed autonomously by
              the AI engine based on safe barrier channel metrics.
            </p>
          </div>
        </div>
      )}

      {/* Autonomous Switch */}
      {aiMode !== 'manual' && (
        <div className="flex items-center justify-between rounded-lg border border-border/80 bg-muted/20 px-3 py-2">
          <div className="space-y-0.5">
            <Label htmlFor="ai-autotrade" className="text-xs font-semibold cursor-pointer">
              Autonomous AI Auto-Entry
            </Label>
            <p className="text-[10px] text-muted-foreground">
              Auto-buy when AI detects high barrier clearance & confidence &ge; {minConfidence}%
            </p>
          </div>
          <Switch
            id="ai-autotrade"
            checked={isAutoTrading}
            onCheckedChange={setIsAutoTrading}
            disabled={!isConnected}
          />
        </div>
      )}

      {/* AI Key Metrics Row */}
      {aiMode !== 'manual' && (
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg bg-muted/40 border border-border/40 p-2">
            <span className="block text-[10px] text-muted-foreground font-medium">Confidence</span>
            <strong
              className={`text-sm ${
                confidence >= minConfidence
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            >
              {confidence}%
            </strong>
          </div>
          <div className="rounded-lg bg-muted/40 border border-border/40 p-2">
            <span className="block text-[10px] text-muted-foreground font-medium">Barrier Room</span>
            <strong
              className={`text-sm ${
                barrierSafety === 'SAFE'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : barrierSafety === 'BORDERLINE'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {barrierSafety}
            </strong>
          </div>
          <div className="rounded-lg bg-muted/40 border border-border/40 p-2">
            <span className="block text-[10px] text-muted-foreground font-medium">Target Ticks</span>
            <strong className="text-sm text-foreground">{targetTicks} ticks</strong>
          </div>
        </div>
      )}

      {/* 1-Click AI Entry Button */}
      {aiMode !== 'manual' && !activePosition && (
        <Button
          type="button"
          size="lg"
          disabled={!isConnected || !proposal || isExecuting || status === 'COOLING_DOWN'}
          onClick={() => void executeAiEntry(true)}
          className="w-full rounded-full bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-700 text-primary-foreground font-semibold shadow-md py-5 text-sm gap-2"
        >
          <Sparkles className="h-4 w-4" />
          <span>
            {isExecuting ? 'AI Placing Accumulator Entry...' : 'AI Place Entry Now'}
          </span>
          <span className="text-[11px] opacity-90 font-normal">
            (${stake} @ {(growthRate * 100).toFixed(0)}%)
          </span>
        </Button>
      )}

      {/* AI Strategy Controls Accordion */}
      {aiMode !== 'manual' && (
        <div className="border-t border-border/50 pt-2">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex w-full items-center justify-between text-[11px] font-semibold text-muted-foreground hover:text-foreground py-1"
          >
            <span className="flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5 text-primary" />
              AI Risk & Execution Parameters
            </span>
            {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>

          {showDetails && (
            <div className="mt-2.5 space-y-3 rounded-lg bg-muted/20 border border-border/40 p-3 text-xs">
              {/* Target Ticks Selection */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Target Duration (Ticks to Exit)</span>
                  <span className="font-semibold text-foreground">{targetTicks} ticks</span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {[2, 3, 4, 5, 6].map((ticks) => (
                    <button
                      key={ticks}
                      type="button"
                      onClick={() => setTargetTicks(ticks)}
                      className={`rounded py-1 text-xs font-semibold border ${
                        targetTicks === ticks
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {ticks}t
                    </button>
                  ))}
                </div>
              </div>

              {/* Min Confidence Threshold */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Min. AI Entry Confidence</span>
                  <span className="font-semibold text-foreground">{minConfidence}%</span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[60, 68, 75, 82].map((conf) => (
                    <button
                      key={conf}
                      type="button"
                      onClick={() => setMinConfidence(conf)}
                      className={`rounded py-1 text-xs font-semibold border ${
                        minConfidence === conf
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {conf}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Auto Take Profit Switch */}
              <div className="flex items-center justify-between pt-1">
                <div className="space-y-0.5">
                  <span className="block text-[11px] font-semibold">AI Target Take-Profit</span>
                  <p className="text-[10px] text-muted-foreground">
                    Auto-sells position as soon as {targetTicks} ticks survive
                  </p>
                </div>
                <Switch
                  checked={autoExitOnTarget}
                  onCheckedChange={setAutoExitOnTarget}
                />
              </div>

              {/* Barrier Shield Switch */}
              <div className="flex items-center justify-between pt-1 border-t border-border/40">
                <div className="space-y-0.5">
                  <span className="block text-[11px] font-semibold flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                    AI Barrier Knockout Shield
                  </span>
                  <p className="text-[10px] text-muted-foreground">
                    Emergency close if spot moves into high barrier danger zone
                  </p>
                </div>
                <Switch
                  checked={barrierShield}
                  onCheckedChange={setBarrierShield}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* AI Decision Rationale */}
      {aiMode !== 'manual' && aiDecision?.rationale && (
        <div className="rounded-lg bg-primary/5 border border-primary/20 p-2.5 text-[11px] space-y-1">
          <div className="flex items-center gap-1 font-semibold text-primary">
            <BrainCircuit className="h-3 w-3" />
            <span>AI Market Assessment:</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">{aiDecision.rationale}</p>
        </div>
      )}

      {/* AI Activity Logs Accordion */}
      {aiLogs.length > 0 && (
        <div className="border-t border-border/50 pt-2">
          <button
            type="button"
            onClick={() => setShowLogs(!showLogs)}
            className="flex w-full items-center justify-between text-[11px] font-semibold text-muted-foreground hover:text-foreground py-1"
          >
            <span className="flex items-center gap-1.5">
              <History className="h-3.5 w-3.5" />
              Live AI Trade Activity ({aiLogs.length})
            </span>
            {showLogs ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>

          {showLogs && (
            <div className="mt-2 max-h-48 overflow-y-auto space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-2 text-xs">
              {aiLogs.slice(0, 8).map((log) => (
                <div key={log.id} className="border-b border-border/40 pb-1.5 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span
                      className={`font-bold ${
                        log.type === 'ENTRY'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : log.type === 'EXIT'
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {log.type}
                    </span>
                    <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="font-medium text-foreground text-[11px]">{log.message}</p>
                  {log.details && (
                    <p className="text-[10px] text-muted-foreground">{log.details}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
