import assert from "assert";
import { Contract } from "ethers";
import { clients, utils as sdkUtils } from "@across-protocol/sdk";
import { Log, DepositWithBlock } from "../interfaces";
import { BackwardEventSearcher, BackwardSearchConfig, BackwardSearchResult } from "../utils/BackwardEventSearcher";
import {
  EventSearchConfig,
  getNetworkName,
  isDefined,
  MakeOptional,
  winston,
  getRelayEventKey,
  getMessageHash,
  spreadEventWithBlockNumber,
  getCurrentTime,
  getRedisCache,
} from "../utils";
import { IndexedSpokePoolClient, IndexerOpts } from "./SpokePoolClient";

export interface BackwardSearchOptions {
  lookbackBlocks?: number;
  maxEvents?: number;
  useAdaptiveSearch?: boolean;
  maxSearchTimeMs?: number;
  targetBlock?: number;
  filterArgs?: { [eventName: string]: any[] };
  chunkSize?: number;
  maxChunkSize?: number;
  growthFactor?: number;
  cacheEnabled?: boolean;
  useHybridSearch?: boolean;
}

export interface EnhancedSpokePoolUpdateResult {
  success: boolean;
  currentTime?: number;
  searchEndBlock?: number;
  events?: any[][];
  reason?: string;
  backwardSearchResult?: BackwardSearchResult;
  searchMethod?: "forward" | "backward" | "hybrid";
}

export class EnhancedSpokePoolClient extends IndexedSpokePoolClient {
  private backwardSearcher: BackwardEventSearcher;
  private lastBackwardSearchTime: number = 0;
  private consecutiveFailures: number = 0;
  private readonly maxConsecutiveFailures = 3;
  private chainConfig?: any; // Will store chain-specific backward search config

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly hubPoolClient: clients.HubPoolClient | null,
    readonly chainId: number,
    public deploymentBlock: number,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = {
      from: deploymentBlock,
    },
    readonly opts: IndexerOpts
  ) {
    super(logger, spokePool, hubPoolClient, chainId, deploymentBlock, eventSearchConfig, opts);
    
    this.initializeBackwardSearcher();
  }

  /**
   * @description Set chain-specific backward search configuration
   */
  setChainConfig(chainConfig: any): void {
    this.chainConfig = chainConfig;
  }

  /**
   * @description Merge provided options with chain-specific configuration
   */
  private mergeOptionsWithChainConfig(options: BackwardSearchOptions): BackwardSearchOptions {
    if (!this.chainConfig) {
      return options;
    }

    return {
      lookbackBlocks: options.lookbackBlocks ?? this.chainConfig.lookbackBlocks,
      maxEvents: options.maxEvents ?? this.chainConfig.maxEvents,
      useAdaptiveSearch: options.useAdaptiveSearch ?? this.chainConfig.enabled,
      maxSearchTimeMs: options.maxSearchTimeMs ?? this.chainConfig.maxTimeMs,
      targetBlock: options.targetBlock,
      filterArgs: options.filterArgs ?? {},
      chunkSize: options.chunkSize ?? this.chainConfig.chunkSize,
      maxChunkSize: options.maxChunkSize ?? this.chainConfig.maxChunkSize,
      growthFactor: options.growthFactor ?? this.chainConfig.growthFactor,
      cacheEnabled: options.cacheEnabled ?? this.chainConfig.cacheEnabled,
      useHybridSearch: options.useHybridSearch ?? this.chainConfig.useHybridSearch,
    };
  }

  private async initializeBackwardSearcher(): Promise<void> {
    try {
      const cache = await getRedisCache(this.logger);
      this.backwardSearcher = new BackwardEventSearcher(
        this.spokePool,
        cache,
        this.logger,
        this.chainId
      );
    } catch (error) {
      this.logger.warn({
        at: "EnhancedSpokePoolClient",
        message: "Failed to initialize cache for backward searcher, proceeding without cache",
        error: error instanceof Error ? error.message : String(error)
      });
      this.backwardSearcher = new BackwardEventSearcher(
        this.spokePool,
        undefined,
        this.logger,
        this.chainId
      );
    }
  }

  /**
   * Enhanced update method that can use backward search for more efficient event discovery
   */
  async updateWithBackwardSearch(
    eventsToQuery: string[],
    options: BackwardSearchOptions = {}
  ): Promise<EnhancedSpokePoolUpdateResult> {
    // Merge options with chain-specific configuration
    const mergedOptions = this.mergeOptionsWithChainConfig(options);
    
    const {
      useAdaptiveSearch = false,
      lookbackBlocks = 10000,
      maxEvents = 1000,
      maxSearchTimeMs = 30000,
      targetBlock,
      filterArgs = {}
    } = mergedOptions;

    if (!useAdaptiveSearch || this.shouldUseFallbackMethod()) {
      // Use standard forward search
      const result = await this._update(eventsToQuery);
      if (result.success) {
        return { 
          success: true,
          currentTime: result.currentTime,
          searchEndBlock: result.searchEndBlock,
          events: result.events,
          searchMethod: "forward" 
        };
      } else {
        return {
          success: false,
          reason: (result as any).reason?.toString(),
          searchMethod: "forward"
        };
      }
    }

    try {
      const latestBlock = await this.spokePool.provider.getBlockNumber();
      
      // Determine if we should use backward search
      const shouldUseBackward = this.shouldUseBackwardSearch(latestBlock);
      
      if (shouldUseBackward) {
        return await this.performBackwardSearch(eventsToQuery, latestBlock, options);
      } else {
        return await this.performHybridSearch(eventsToQuery, latestBlock, options);
      }
    } catch (error) {
      this.logger.warn({
        at: "EnhancedSpokePoolClient",
        message: "Backward search failed, falling back to forward search",
        error: error instanceof Error ? error.message : String(error),
        chainId: this.chainId
      });
      
      this.consecutiveFailures++;
      const result = await this._update(eventsToQuery);
      if (result.success) {
        return { 
          success: true,
          currentTime: result.currentTime,
          searchEndBlock: result.searchEndBlock,
          events: result.events,
          searchMethod: "forward" 
        };
      } else {
        return {
          success: false,
          reason: (result as any).reason?.toString(),
          searchMethod: "forward"
        };
      }
    }
  }

  private async performBackwardSearch(
    eventsToQuery: string[],
    latestBlock: number,
    options: BackwardSearchOptions
  ): Promise<EnhancedSpokePoolUpdateResult> {
    const searchConfig: BackwardSearchConfig = {
      eventsToFind: eventsToQuery,
      maxEvents: options.maxEvents || 1000,
      maxBlocksBack: options.lookbackBlocks || 10000,
      targetBlock: options.targetBlock,
      initialChunkSize: options.chunkSize || 500,
      maxChunkSize: options.maxChunkSize || 5000,
      chunkGrowthFactor: options.growthFactor || 2.0,
      filterArgs: options.filterArgs || {},
      cachePrefix: `enhanced-spoke-${this.chainId}`
    };

    const searchResult = await this.backwardSearcher.searchBackward(latestBlock, searchConfig);
    
    // Process the found events
    this.processBackwardSearchResults(searchResult.events, eventsToQuery);
    
    this.lastBackwardSearchTime = getCurrentTime();
    this.consecutiveFailures = 0; // Reset on success

    return {
      success: true,
      currentTime: getCurrentTime(),
      searchEndBlock: latestBlock,
      events: this.formatEventsForUpdate(searchResult.events, eventsToQuery),
      backwardSearchResult: searchResult,
      searchMethod: "backward"
    };
  }

  private async performHybridSearch(
    eventsToQuery: string[],
    latestBlock: number,
    options: BackwardSearchOptions
  ): Promise<EnhancedSpokePoolUpdateResult> {
    // Use backward search for recent events (last 1000 blocks) and forward search for older events
    const recentBlockThreshold = 1000;
    const recentSearchBlock = Math.max(latestBlock - recentBlockThreshold, this.deploymentBlock);

    // First, get recent events via backward search
    const recentSearchConfig: BackwardSearchConfig = {
      eventsToFind: eventsToQuery,
      maxEvents: options.maxEvents ? Math.floor(options.maxEvents / 2) : 500,
      maxBlocksBack: recentBlockThreshold,
      targetBlock: recentSearchBlock,
      initialChunkSize: options.chunkSize ? Math.floor(options.chunkSize / 2) : 200,
      maxChunkSize: options.maxChunkSize ? Math.floor(options.maxChunkSize / 2) : 1000,
      chunkGrowthFactor: options.growthFactor || 1.5,
      filterArgs: options.filterArgs || {},
      cachePrefix: `hybrid-recent-${this.chainId}`
    };

    const recentSearchResult = await this.backwardSearcher.searchBackward(latestBlock, recentSearchConfig);

    // Then, use forward search for any remaining quota and older events
    const forwardResult = await this._update(eventsToQuery);

    // Combine results - convert forward search events to Log format
    const allEvents = [...recentSearchResult.events];
    if (forwardResult.success && forwardResult.events) {
      forwardResult.events.forEach((eventArray) => {
        if (Array.isArray(eventArray)) {
          // Convert each event to Log format
          eventArray.forEach((event: any) => {
            if (event && typeof event === 'object') {
              allEvents.push(event);
            }
          });
        }
      });
    }

    // Remove duplicates and sort
    const uniqueEvents = this.deduplicateEvents(allEvents);
    this.processBackwardSearchResults(uniqueEvents, eventsToQuery);

    this.lastBackwardSearchTime = getCurrentTime();
    this.consecutiveFailures = 0;

    return {
      success: true,
      currentTime: getCurrentTime(),
      searchEndBlock: latestBlock,
      events: this.formatEventsForUpdate(uniqueEvents, eventsToQuery),
      backwardSearchResult: recentSearchResult,
      searchMethod: "hybrid"
    };
  }

  private shouldUseBackwardSearch(currentBlock: number): boolean {
    // Check if backward search is enabled for this chain
    if (this.chainConfig && !this.chainConfig.enabled) {
      return false;
    }

    // Use backward search when:
    // 1. First run after startup
    // 2. After a significant gap in updates (>5 minutes)
    // 3. When we haven't done a backward search recently (>10 minutes)

    const now = getCurrentTime();
    const timeSinceLastBackwardSearch = now - this.lastBackwardSearchTime;
    const hasRecentBackwardSearch = timeSinceLastBackwardSearch < 600; // 10 minutes

    const isLongGapUpdate = timeSinceLastBackwardSearch > 300; // 5 minutes
    const isFirstRun = this.lastBackwardSearchTime === 0;

    const shouldUse = isFirstRun || !hasRecentBackwardSearch || isLongGapUpdate;

    // If chain config specifies hybrid search, prefer that over pure backward search
    if (this.chainConfig?.useHybridSearch && !shouldUse) {
      return false; // Let hybrid search handle it
    }

    return shouldUse;
  }

  private shouldUseFallbackMethod(): boolean {
    // Fall back to forward search if we've had too many consecutive failures
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  private processBackwardSearchResults(events: Log[], eventsToQuery: string[]): void {
    // This method processes the backward search results
    // The actual event processing is handled by the parent class's _update method
    // We'll just log the processing for now
    this.logger.debug({
      at: "EnhancedSpokePoolClient#processBackwardSearchResults",
      message: "Processing backward search results",
      eventsProcessed: events.length,
      eventsToQuery,
      chainId: this.chainId,
    });
  }

  private formatEventsForUpdate(events: Log[], eventsToQuery: string[]): any[][] {
    // Format events according to the existing SpokePoolUpdate interface
    return eventsToQuery.map((eventName) => {
      return events
        .filter(event => event.event === eventName)
        .map(spreadEventWithBlockNumber);
    });
  }

  private deduplicateEvents(events: Log[]): Log[] {
    const seen = new Set<string>();
    return events.filter(event => {
      // Create a unique key for each event
      const key = `${event.blockNumber}-${event.transactionHash}-${event.logIndex}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Find the most recent deposit event within a specified block range
   */
  async findMostRecentDeposit(
    maxBlocksBack: number = 5000,
    depositorAddress?: string
  ): Promise<DepositWithBlock | null> {
    const latestBlock = await this.spokePool.provider.getBlockNumber();
    const filterArgs = depositorAddress ? { FundsDeposited: [depositorAddress] } : {};

    const result = await this.backwardSearcher.findMostRecentEvent(latestBlock, {
      eventsToFind: ["FundsDeposited"],
      maxBlocksBack,
      initialChunkSize: 100,
      maxChunkSize: 1000,
      chunkGrowthFactor: 2,
      filterArgs
    });

    if (!result) return null;

    return {
      ...spreadEventWithBlockNumber(result),
      messageHash: result.args.messageHash ?? getMessageHash(result.args.message),
    } as DepositWithBlock;
  }

  /**
   * Find all deposits for a specific token within a time window
   */
  async findRecentDepositsForToken(
    tokenAddress: string,
    maxAgeSeconds: number = 3600
  ): Promise<DepositWithBlock[]> {
    const latestBlock = await this.spokePool.provider.getBlockNumber();

    const result = await this.backwardSearcher.findEventsInTimeWindow(latestBlock, maxAgeSeconds, {
      eventsToFind: ["FundsDeposited"],
      maxEvents: 100,
      initialChunkSize: 200,
      maxChunkSize: 2000,
      chunkGrowthFactor: 1.8,
      filterArgs: {
        FundsDeposited: [null, null, tokenAddress] // [depositor, recipient, inputToken]
      }
    });

    return result.events
      .filter(event => event.event === "FundsDeposited")
      .map(event => ({
        ...spreadEventWithBlockNumber(event),
        messageHash: event.args.messageHash ?? getMessageHash(event.args.message),
      } as DepositWithBlock));
  }

  /**
   * Override the standard update method to provide backward search capability
   */
  override async update(eventsToQuery?: string[]): Promise<void> {
    const events = eventsToQuery || this._queryableEventNames();
    
    // For now, keep the standard behavior by default
    // Users can explicitly call updateWithBackwardSearch for enhanced functionality
    await this._update(events);
  }

  /**
   * Get statistics about the enhanced spoke pool client performance
   */
  getSearchStatistics(): {
    lastBackwardSearchTime: number;
    consecutiveFailures: number;
    chainId: number;
    deploymentBlock: number;
  } {
    return {
      lastBackwardSearchTime: this.lastBackwardSearchTime,
      consecutiveFailures: this.consecutiveFailures,
      chainId: this.chainId,
      deploymentBlock: this.deploymentBlock,
    };
  }
}