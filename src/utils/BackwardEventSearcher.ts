import assert from "assert";
import { Contract } from "ethers";
import winston from "winston";
import { Log } from "../interfaces";
import { CachingMechanismInterface } from "../interfaces";
import { getCurrentTime } from "./SDKUtils";
import { paginatedEventQuery } from "./EventUtils";

export interface BackwardSearchConfig {
  targetBlock?: number;          // Stop at this block (inclusive)
  maxEvents?: number;            // Stop after finding N events
  maxBlocksBack?: number;        // Max distance to search backward
  initialChunkSize: number;      // Start with this chunk size
  maxChunkSize: number;          // Never exceed this chunk size
  chunkGrowthFactor: number;     // Multiply chunk size by this when no events found
  eventsToFind: string[];        // Event names to search for
  cachePrefix?: string;          // Redis cache key prefix
  filterArgs?: { [eventName: string]: any[] }; // Event filter arguments
}

export interface BackwardSearchResult {
  events: Log[];
  searchedToBlock: number;
  totalBlocksSearched: number;
  cacheHits: number;
  searchTimeMs: number;
}

export class BackwardEventSearcher {
  constructor(
    private contract: Contract,
    private cache: CachingMechanismInterface | undefined,
    private logger: winston.Logger,
    private chainId: number
  ) {}

  async searchBackward(
    fromBlock: number,
    config: BackwardSearchConfig
  ): Promise<BackwardSearchResult> {
    const startTime = getCurrentTime() * 1000;
    const {
      targetBlock = 0,
      maxEvents = Infinity,
      maxBlocksBack = 100000,
      initialChunkSize = 1000,
      maxChunkSize = 10000,
      chunkGrowthFactor = 1.5,
      eventsToFind,
      cachePrefix = `backward-search-${this.chainId}`,
      filterArgs = {}
    } = config;

    assert(fromBlock >= targetBlock, "fromBlock must be >= targetBlock");
    assert(initialChunkSize > 0, "initialChunkSize must be positive");
    assert(maxChunkSize >= initialChunkSize, "maxChunkSize must be >= initialChunkSize");
    assert(chunkGrowthFactor >= 1, "chunkGrowthFactor must be >= 1");

    let currentBlock = fromBlock;
    let chunkSize = initialChunkSize;
    let allEvents: Log[] = [];
    let totalBlocksSearched = 0;
    let cacheHits = 0;
    const minBlock = Math.max(targetBlock, fromBlock - maxBlocksBack);

    this.logger.debug({
      at: "BackwardEventSearcher",
      message: "Starting backward search",
      fromBlock,
      minBlock,
      maxEvents,
      eventsToFind,
      chainId: this.chainId
    });

    while (currentBlock > minBlock && allEvents.length < maxEvents) {
      const chunkStart = Math.max(currentBlock - chunkSize + 1, minBlock);
      const chunkEnd = currentBlock;

      // Check cache first
      const cacheKey = `${cachePrefix}-${chunkStart}-${chunkEnd}-${eventsToFind.join(",")}`;
      const cachedResult = await this.getCachedEvents(cacheKey);

      let chunkEvents: Log[];
      if (cachedResult) {
        chunkEvents = cachedResult;
        cacheHits++;
        this.logger.debug({
          at: "BackwardEventSearcher",
          message: "Cache hit",
          chunkStart,
          chunkEnd,
          eventCount: chunkEvents.length
        });
      } else {
        // Fetch events for this chunk
        chunkEvents = await this.fetchEventsForRange(
          chunkStart,
          chunkEnd,
          eventsToFind,
          filterArgs
        );

        // Cache the result (cache for 1 hour)
        await this.cacheEvents(cacheKey, chunkEvents, 3600);
        
        this.logger.debug({
          at: "BackwardEventSearcher",
          message: "Fetched and cached events",
          chunkStart,
          chunkEnd,
          eventCount: chunkEvents.length
        });
      }

      // Add events (sort them by block number desc, then log index desc)
      chunkEvents.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return b.blockNumber - a.blockNumber;
        }
        return b.logIndex - a.logIndex;
      });

      allEvents.push(...chunkEvents);
      totalBlocksSearched += (chunkEnd - chunkStart + 1);

      // Adaptive chunk sizing
      if (chunkEvents.length === 0) {
        // No events found, increase chunk size for next iteration
        chunkSize = Math.min(Math.floor(chunkSize * chunkGrowthFactor), maxChunkSize);
        this.logger.debug({
          at: "BackwardEventSearcher",
          message: "No events found, increasing chunk size",
          newChunkSize: chunkSize
        });
      } else {
        // Events found, reset to smaller chunk size for precision
        chunkSize = initialChunkSize;
      }

      currentBlock = chunkStart - 1;

      // Stop early if we have enough events
      if (allEvents.length >= maxEvents) {
        allEvents = allEvents.slice(0, maxEvents);
        this.logger.debug({
          at: "BackwardEventSearcher",
          message: "Reached max events limit",
          maxEvents,
          foundEvents: allEvents.length
        });
        break;
      }

      // Rate limiting delay to avoid overwhelming RPC
      await this.delay(50);
    }

    // Final sort of all events by block number (desc) then log index (desc)
    allEvents.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return b.blockNumber - a.blockNumber;
      }
      return b.logIndex - a.logIndex;
    });

    const searchTimeMs = getCurrentTime() * 1000 - startTime;
    
    this.logger.info({
      at: "BackwardEventSearcher",
      message: "Backward search completed",
      fromBlock,
      searchedToBlock: currentBlock + 1,
      totalEvents: allEvents.length,
      totalBlocksSearched,
      cacheHits,
      searchTimeMs: Math.round(searchTimeMs),
      chainId: this.chainId
    });

    return {
      events: allEvents,
      searchedToBlock: currentBlock + 1,
      totalBlocksSearched,
      cacheHits,
      searchTimeMs
    };
  }

  private async fetchEventsForRange(
    fromBlock: number,
    toBlock: number,
    eventNames: string[],
    filterArgs: { [eventName: string]: any[] }
  ): Promise<Log[]> {
    const events: Log[] = [];

    for (const eventName of eventNames) {
      try {
        // Create event filter with optional arguments
        const args = filterArgs[eventName] || [];
        const filter = this.contract.filters[eventName](...args);
        
        // Use existing paginated query logic for robust querying
        const eventLogs = await paginatedEventQuery(
          this.contract,
          filter,
          {
            from: fromBlock,
            to: toBlock,
            maxLookBack: toBlock - fromBlock + 1
          }
        );
        
        events.push(...eventLogs);
      } catch (error) {
        this.logger.warn({
          at: "BackwardEventSearcher",
          message: "Failed to fetch events for range",
          eventName,
          fromBlock,
          toBlock,
          error: error instanceof Error ? error.message : String(error)
        });
        
        // Retry with smaller range if it's a large range
        if (toBlock - fromBlock > 1000) {
          const midBlock = Math.floor((fromBlock + toBlock) / 2);
          const firstHalf = await this.fetchEventsForRange(fromBlock, midBlock, [eventName], filterArgs);
          const secondHalf = await this.fetchEventsForRange(midBlock + 1, toBlock, [eventName], filterArgs);
          events.push(...firstHalf, ...secondHalf);
        } else {
          // For small ranges, skip this event type and continue
          this.logger.error({
            at: "BackwardEventSearcher",
            message: "Skipping event type due to persistent error",
            eventName,
            fromBlock,
            toBlock,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return events;
  }

  private async getCachedEvents(cacheKey: string): Promise<Log[] | null> {
    if (!this.cache) return null;
    
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached as string);
        return Array.isArray(parsed) ? parsed : null;
      }
      return null;
    } catch (error) {
      this.logger.warn({
        at: "BackwardEventSearcher",
        message: "Cache read failed",
        cacheKey,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async cacheEvents(cacheKey: string, events: Log[], ttlSeconds: number): Promise<void> {
    if (!this.cache) return;

    try {
      await this.cache.set(cacheKey, JSON.stringify(events), ttlSeconds);
    } catch (error) {
      this.logger.warn({
        at: "BackwardEventSearcher",
        message: "Cache write failed",
        cacheKey,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Find the most recent event of specified types within a block range
   */
  async findMostRecentEvent(
    fromBlock: number,
    config: Omit<BackwardSearchConfig, 'maxEvents'>
  ): Promise<Log | null> {
    const result = await this.searchBackward(fromBlock, {
      ...config,
      maxEvents: 1
    });
    
    return result.events.length > 0 ? result.events[0] : null;
  }

  /**
   * Find events within a specific time window (approximate, based on block timestamps)
   */
  async findEventsInTimeWindow(
    fromBlock: number,
    maxAgeSeconds: number,
    config: Omit<BackwardSearchConfig, 'targetBlock' | 'maxBlocksBack'>
  ): Promise<BackwardSearchResult> {
    const currentBlockTime = await this.getBlockTimestamp(fromBlock);
    const targetTimestamp = currentBlockTime - maxAgeSeconds;
    
    // Estimate blocks based on ~12 second block time
    const estimatedBlocksBack = Math.ceil(maxAgeSeconds / 12);
    
    return this.searchBackward(fromBlock, {
      ...config,
      maxBlocksBack: estimatedBlocksBack * 2, // Add buffer for block time variance
      targetBlock: Math.max(0, fromBlock - estimatedBlocksBack * 3) // Even more conservative target
    });
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    try {
      const block = await this.contract.provider.getBlock(blockNumber);
      return block.timestamp;
    } catch (error) {
      this.logger.warn({
        at: "BackwardEventSearcher",
        message: "Failed to get block timestamp",
        blockNumber,
        error: error instanceof Error ? error.message : String(error)
      });
      // Return current time as fallback
      return getCurrentTime();
    }
  }
}