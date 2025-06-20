# Backward Event Search Implementation

This document describes the complete implementation of a backward event search system for the Across Protocol relayer, enabling efficient discovery of blockchain events by searching backwards from the latest block.

## Overview

The backward search system provides an alternative to the traditional forward event scanning approach, offering several advantages:

- **Adaptive Performance**: Adjusts chunk sizes based on event density
- **Cache Optimization**: Avoids re-querying the same block ranges using Redis
- **Graceful Degradation**: Falls back to smaller ranges on RPC errors
- **Intelligent Stopping**: Can stop based on blocks searched, events found, or time limits
- **Resume Capability**: Can continue from where it left off using cached data

## Core Components

### 1. BackwardEventSearcher (`src/utils/BackwardEventSearcher.ts`)

The main class that implements the backward search algorithm.

**Key Features:**
- Adaptive chunk sizing that grows when no events are found
- Redis caching for previously searched block ranges
- Rate limiting to respect RPC endpoint limits
- Comprehensive error handling and recovery
- Support for multiple event types and filtering

**Usage:**
```typescript
const searcher = new BackwardEventSearcher(contract, cache, logger, chainId);
const result = await searcher.searchBackward(latestBlock, {
  eventsToFind: ["FundsDeposited", "FilledRelay"],
  maxEvents: 1000,
  maxBlocksBack: 10000,
  initialChunkSize: 500,
  maxChunkSize: 5000,
  chunkGrowthFactor: 2.0
});
```

### 2. EnhancedSpokePoolClient (`src/clients/EnhancedSpokePoolClient.ts`)

An enhanced version of the SpokePoolClient that incorporates backward search capabilities.

**Key Features:**
- Three search modes: backward, forward, and hybrid
- Automatic fallback to forward search on failures
- Deduplication of events when using hybrid mode
- Specialized methods for finding recent deposits and token-specific events
- Performance tracking and statistics

**Usage:**
```typescript
const result = await client.updateWithBackwardSearch(["FundsDeposited"], {
  useAdaptiveSearch: true,
  lookbackBlocks: 10000,
  maxEvents: 1000
});
```

### 3. Configuration Options (`src/relayer/RelayerConfig.ts`)

Added comprehensive configuration options for backward search:

**Environment Variables:**
- `RELAYER_ENABLE_BACKWARD_SEARCH`: Enable/disable backward search
- `RELAYER_BACKWARD_SEARCH_LOOKBACK`: Maximum blocks to search backward
- `RELAYER_BACKWARD_SEARCH_MAX_EVENTS`: Maximum events to return
- `RELAYER_BACKWARD_SEARCH_CHUNK_SIZE`: Initial chunk size for searching
- `RELAYER_BACKWARD_SEARCH_MAX_CHUNK_SIZE`: Maximum chunk size
- `RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR`: Factor to grow chunk size when no events found
- `RELAYER_BACKWARD_SEARCH_CACHE_ENABLED`: Enable/disable Redis caching
- `RELAYER_BACKWARD_SEARCH_MAX_TIME_MS`: Maximum search time in milliseconds
- `RELAYER_USE_HYBRID_SEARCH`: Enable hybrid forward/backward search mode

### 4. Relayer Integration (`src/relayer/Relayer.ts`)

The main Relayer class has been enhanced to use backward search when enabled:

**Integration Points:**
- Automatic detection of when to use backward search (startup, long gaps)
- Fallback mechanisms for reliability
- Performance logging and monitoring
- Seamless integration with existing update cycle

## Search Strategies

### 1. Backward Search
Searches from the latest block backwards, using adaptive chunk sizing:
- Starts with small chunks for precision
- Grows chunk size when no events are found
- Caches results to avoid redundant queries
- Stops when target conditions are met

### 2. Hybrid Search
Combines backward and forward search for optimal performance:
- Uses backward search for recent events (last 1000 blocks)
- Uses forward search for historical events
- Deduplicates overlapping results
- Provides best of both approaches

### 3. Forward Search (Fallback)
Traditional forward search for compatibility and reliability:
- Used when backward search is disabled
- Automatic fallback on consecutive failures
- Maintains existing behavior and compatibility

## Advanced Features

### Intelligent Caching
- Redis-based caching of block range results
- TTL-based cache expiration (1 hour default)
- Cache key includes chain ID, block range, and event types
- Graceful degradation when cache is unavailable

### Adaptive Performance
- Dynamic chunk size adjustment based on event density
- Rate limiting to prevent RPC overload
- Early termination on various conditions
- Performance metrics and timing

### Error Handling
- Graceful degradation on RPC errors
- Automatic retry with smaller ranges
- Fallback to forward search
- Comprehensive logging and monitoring

### Specialized Search Methods
- `findMostRecentEvent()`: Find the single most recent event
- `findEventsInTimeWindow()`: Find events within a time period
- `findRecentDepositsForToken()`: Token-specific deposit searches

## Performance Benefits

### When Backward Search Excels
1. **Startup Recovery**: Quickly find recent events after downtime
2. **Recent Event Discovery**: More efficient for finding recent deposits
3. **Gap Filling**: Efficiently fill missing events after connection issues
4. **Sparse Event Chains**: Better performance on chains with few events

### When Forward Search is Better
1. **Dense Event Chains**: Forward search may be more efficient
2. **Historical Analysis**: When analyzing older events
3. **Complete Synchronization**: When full historical sync is needed

## Usage Examples

### Enable Backward Search
```bash
# Enable backward search with custom settings
export RELAYER_ENABLE_BACKWARD_SEARCH=true
export RELAYER_BACKWARD_SEARCH_LOOKBACK=20000
export RELAYER_BACKWARD_SEARCH_MAX_EVENTS=500
export RELAYER_BACKWARD_SEARCH_CHUNK_SIZE=1000
```

### Hybrid Mode
```bash
# Use hybrid search for best performance
export RELAYER_USE_HYBRID_SEARCH=true
export RELAYER_ENABLE_BACKWARD_SEARCH=true
```

### Find Recent Deposits
```typescript
// Find most recent deposit for a specific user
const recentDeposit = await client.findMostRecentDeposit(5000, userAddress);

// Find all USDC deposits in the last hour
const usdcDeposits = await client.findRecentDepositsForToken(usdcAddress, 3600);
```

## Testing

Comprehensive test suites have been implemented:

### BackwardEventSearcher Tests (`test/BackwardEventSearcher.ts`)
- Adaptive chunk sizing behavior
- Cache hit/miss scenarios
- Error handling and recovery
- Edge cases and validation
- Performance characteristics

### EnhancedSpokePoolClient Tests (`test/EnhancedSpokePoolClient.ts`)
- Backward, forward, and hybrid search modes
- Fallback mechanisms
- Event deduplication
- Specialized search methods
- Failure recovery

## Monitoring and Debugging

### Performance Metrics
- Search time measurements
- Cache hit ratios
- Block ranges searched
- Events found per search
- Consecutive failure tracking

### Logging
- Detailed search progress logging
- Cache performance metrics
- Error conditions and fallbacks
- Configuration validation
- Performance statistics

### Statistics API
```typescript
const stats = client.getSearchStatistics();
console.log({
  lastBackwardSearchTime: stats.lastBackwardSearchTime,
  consecutiveFailures: stats.consecutiveFailures,
  pendingEventsCount: stats.pendingEventsCount
});
```

## Migration and Compatibility

### Backward Compatibility
- Disabled by default (requires explicit opt-in)
- Fallback to existing forward search
- No breaking changes to existing APIs
- Graceful degradation on failures

### Gradual Rollout
1. Deploy with backward search disabled
2. Enable on subset of chains for testing
3. Monitor performance and error rates
4. Gradually enable on all chains
5. Consider making default in future releases

## Future Enhancements

### Potential Improvements
1. **Machine Learning**: Use ML to predict optimal chunk sizes
2. **Multi-Provider Searching**: Search across multiple RPC providers simultaneously
3. **Event Prediction**: Predict likely event locations based on patterns
4. **Cross-Chain Coordination**: Coordinate searches across related chains
5. **Advanced Caching**: More sophisticated caching strategies

### Performance Optimizations
1. **Parallel Searching**: Search multiple ranges simultaneously
2. **Bloom Filters**: Use bloom filters for quick event existence checks
3. **Binary Search**: Use binary search for timestamp-based searches
4. **Predictive Prefetching**: Prefetch likely-needed block ranges

This implementation provides a robust, efficient, and flexible backward event search system that significantly improves the relayer's ability to discover and process blockchain events while maintaining full backward compatibility and reliability.