# Dynamic Gas Calculation Usage Example

## Overview

The enhanced ProfitClient now supports dynamic gas calculation based on historical intent data from `intents.json`. This feature allows relayers to optimize gas prices dynamically instead of using static scalers.

## Usage

### 1. Basic Usage - Enhanced Profit Calculation

```typescript
// Use the new method with optional dynamic gas calculation
const profitResult = await profitClient.getFillProfitabilityWithOptimalGas(
  deposit,
  lpFeePct,
  l1Token,
  repaymentChainId,
  true  // useOptimalGas = true (default)
);

// Check if optimal gas was used
if (profitResult.optimalGas?.isOptimal) {
  console.log(`Using optimal gas price: ${profitResult.optimalGas.gasPrice}`);
  console.log(`Historical profit BPS: ${profitResult.optimalGas.profitBps}`);
} else {
  console.log("Falling back to standard gas calculation");
}
```

### 2. Direct Optimal Gas Calculation

```typescript
// Calculate optimal gas parameters directly
const optimalGasResult = await profitClient.calculateOptimalGas(
  deposit,
  baseFee,     // Current base fee in wei
  gasUsed,     // Estimated gas usage
  relayerFee   // Relayer fee in output token units
);

if (optimalGasResult?.isOptimal) {
  // Use the optimal gas parameters
  const { gasPrice, maxFeePerGas, maxPriorityFeePerGas, profitBps } = optimalGasResult;
  console.log(`Optimal gas price: ${gasPrice} wei`);
  console.log(`Target profit: ${profitBps} BPS`);
}
```

## Intent History Data Format

Create an `intents.json` file in your project root with historical fill data:

```json
[
  {
    "outputAmount": 1000000000000000000,
    "baseFee": 12000000000,
    "profitBps": 15.5,
    "srcChainId": 1,
    "dstChainId": 10,
    "tokenSymbol": "ETH",
    "timestamp": 1640995200
  },
  {
    "outputAmount": 500000000000000000,
    "baseFee": 15000000000,
    "profitBps": 12.3,
    "srcChainId": 1,
    "dstChainId": 137,
    "tokenSymbol": "USDC",
    "timestamp": 1640995300
  }
]
```

## Key Features

### 1. Multi-Stage Filtering
- Filters by chain pair (origin → destination)
- Filters by token symbol
- Sorts by amount proximity (top 100)
- Sorts by base fee proximity (top 30)

### 2. Dynamic Profit BPS Calculation
- **Exclusive orders**: Use full historical average (100%)
- **Non-exclusive (Mainnet)**: 65% of historical average (higher competition)
- **Non-exclusive (L2s)**: 80% of historical average (moderate competition)

### 3. Safety Features
- Minimum output amount: 0.01 ETH equivalent
- Minimum profit rate: 0.5 BPS
- Automatic fallback to static calculation when no historical data
- Negative priority fee handling with chain-specific minimums

### 4. Integration with Existing System
- Backward compatible with existing `getFillProfitability()`
- Seamless fallback when historical data unavailable
- Maintains all existing minimum relayer fee configurations

## Configuration

The system respects existing environment variables:
- `MIN_RELAYER_FEE_PCT_*`: Minimum relayer fee requirements
- `PRIORITY_FEE_SCALER`: Used in fallback mode
- `MAX_FEE_PER_GAS_SCALER`: Used in fallback mode

## Performance

- Intent history cached for 1 minute
- Asynchronous loading doesn't block critical operations
- Graceful degradation when file operations fail