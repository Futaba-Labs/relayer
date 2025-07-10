# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

**Across Protocol V3 Relayer** is a cross-chain bridge system that enables instant asset transfers between EVM networks. The relayer component provides immediate liquidity by fulfilling user deposits on destination chains before slow canonical bridges complete, earning fees for this service.

**Key Functions:**
- **Instant Cross-Chain Transfers**: Users deposit tokens on origin chain, relayers fulfill on destination chain within ~1 minute
- **Economic Incentive System**: Relayers compete to fill profitable deposits, creating sustainable operation
- **Multi-Chain Support**: Handles 20+ chains including Ethereum, Polygon, Arbitrum, Optimism, Base, etc.
- **Automated Rebalancing**: Manages token inventory across chains to maintain liquidity

## Development Commands

### Build & Development
- `yarn build` - Build the TypeScript project
- `yarn build:test` - Build test configuration
- `yarn watch` - Build with incremental watch mode
- `yarn clean` - Clean node_modules
- `yarn reinstall` - Clean and reinstall dependencies

### Testing & Quality
- `yarn test` - Run test suite (uses Hardhat with RELAYER_TEST=true)
- `yarn lint` - Check code style (ESLint + Prettier)
- `yarn lint-fix` - Fix linting issues automatically

### Running Bots
- `yarn relay` - Run relayer bot (`node ./dist/index.js --relayer`)
- `yarn run-proposer` - Run dataworker in proposer mode
- `yarn run-executor` - Run dataworker in executor mode
- `yarn run-disputer` - Run dataworker in disputer mode
- `yarn run-finalizer` - Run finalizer bot

### Integration Testing
- `LOG_IN_TEST=true yarn hardhat integration-tests --wallet mnemonic` - Run integration tests safely

## Technologies Used

### Core Stack
- **TypeScript** - Primary language with strict typing
- **Node.js >=20.18.0** - Runtime environment
- **Ethers.js v5** - Ethereum blockchain interaction
- **Hardhat** - Development framework and testing
- **Redis** - In-memory database for caching blockchain data
- **Winston** - Structured logging

### Blockchain Libraries
- **@across-protocol/sdk** - Core Across protocol SDK
- **@across-protocol/contracts** - Smart contract interfaces
- **@across-protocol/constants** - Chain/token constants
- **@eth-optimism/sdk** - Optimism L2 integration
- **@arbitrum/sdk** - Arbitrum L2 integration
- **@maticnetwork/maticjs** - Polygon bridging
- **zksync-ethers** - zkSync Era support

### Development Tools
- **ESLint + Prettier** - Code linting and formatting
- **Mocha + Chai** - Testing framework
- **Sinon** - Test mocking and stubbing
- **TypeChain** - TypeScript contract bindings

## Architecture Overview

### Four Main Bot Types
1. **Relayer** (`src/relayer/`) - Provides instant liquidity by filling user deposits across chains
2. **Dataworker** (`src/dataworker/`) - Bundles transactions, proposes/executes root bundles for settlement
3. **Monitor** (`src/monitor/`) - Monitors system health and generates reports
4. **Finalizer** (`src/finalizer/`) - Finalizes cross-chain messages and withdrawals

### Main Architecture Patterns

#### Event-Driven Architecture
- **SpokePoolClients** continuously monitor blockchain events (`FundsDeposited`, `FilledRelay`)
- **Hub-Spoke Model**: Central HubPool on Ethereum L1 coordinates with SpokePools on L2s
- **Event Filtering**: Comprehensive filtering by addresses, tokens, and time ranges

#### Client-Service Pattern
All bots share standardized client architecture:
- **Client Abstraction**: Each blockchain interaction encapsulated in dedicated clients
- **Update Cycle**: All clients implement `.update()` methods for fresh state
- **Dependency Injection**: Clients injected into main service classes via helper constructors

#### Profitability-Driven Operations
- **ProfitClient**: Calculates gas costs vs. fees before executing any fill
- **Dynamic Fee Calculation**: Considers gas prices, token prices, and LP fees
- **Risk Management**: Configurable profitability thresholds per chain/token

#### Cross-Chain State Management
- **Inventory Tracking**: Maintains token balances across all supported chains
- **Automatic Rebalancing**: Moves tokens between chains when inventory becomes unbalanced
- **Fill Tracking**: Prevents double-filling and manages fill status across chains

### Key Client Architecture
All bots share a common client architecture (`src/clients/`):
- **SpokePoolClient** - Handles spoke pool events and state per chain
- **HubPoolClient** - Manages hub pool state and root bundle logic
- **ConfigStoreClient** - Provides configuration and routing information
- **InventoryClient** - Manages cross-chain token inventory and rebalancing
- **TokenClient** - Handles token approvals and transfers
- **ProfitClient** - Calculates fill profitability

### Main Entry Point

**Location**: `index.ts` (root directory)

**Function**: CLI router that determines which bot mode to run based on command-line arguments.

**Usage Pattern**:
```bash
node ./dist/index.js --relayer --wallet <wallet_type>
node ./dist/index.js --dataworker --wallet <wallet_type>
node ./dist/index.js --monitor --wallet <wallet_type>
node ./dist/index.js --finalizer --wallet <wallet_type>
```

**Flow**:
1. Parses CLI args using `minimist`
2. Validates wallet configuration
3. Constructs signer from wallet args
4. Routes to appropriate bot runner function (`runRelayer`, `runDataworker`, etc.)
5. Handles graceful shutdown and error logging

### Folder Structure

```
src/
├── relayer/           # Relayer bot implementation
│   ├── Relayer.ts          # Main relayer orchestration class
│   ├── RelayerConfig.ts    # Configuration management
│   ├── RelayerClientHelper.ts # Client construction and DI
│   └── index.ts            # Entry point and loop management
├── dataworker/        # Bundle proposing/execution bot
├── monitor/           # System monitoring and alerting
├── finalizer/         # Cross-chain message finalization
├── clients/           # Blockchain client abstractions
│   ├── bridges/            # Cross-chain bridge adapters
│   ├── SpokePoolClient.ts  # Spoke pool event monitoring
│   ├── HubPoolClient.ts    # Hub pool state management
│   ├── InventoryClient.ts  # Token inventory management
│   ├── ProfitClient.ts     # Profitability calculations
│   └── TokenClient.ts      # Token operations and approvals
├── adapter/           # Chain-specific bridge logic
│   ├── bridges/            # L1→L2 bridge implementations
│   └── l2Bridges/          # L2→L1 bridge implementations
├── common/            # Shared configuration and utilities
├── interfaces/        # TypeScript type definitions
└── utils/             # Utility functions and helpers
```

### Key Data Models

#### Core Deposit/Fill Types
- **`Deposit`**: User's cross-chain transfer request with origin/destination details
- **`DepositWithBlock`**: Deposit enriched with block number and transaction data
- **`Fill`**: Relayer's fulfillment of a deposit on destination chain
- **`FillWithBlock`**: Fill enriched with block/transaction metadata
- **`RelayData`**: Complete relay information including fees and proof data

#### Configuration Models
- **`RelayerConfig`**: Chain selection, token lists, profitability thresholds, gas settings
- **`InventoryConfig`**: Token balance targets and rebalancing rules per chain
- **`TokenBalanceConfig`**: Per-token inventory management rules

#### Financial Models
- **`RepaymentFee`**: LP fee calculations for different repayment chains
- **`RepaymentChainProfitability`**: Gas costs vs. fee revenue calculations
- **`RelayerUnfilledDeposit`**: Deposits available for filling with profitability metadata

#### Bridge/Transfer Models
- **`OutstandingTransfers`**: Pending cross-chain transfers by token/address
- **`TokensBridged`**: Cross-chain token transfer events
- **`CrossChainMessage`**: Generic cross-chain message with finalization data

### Error Handling in src/relayer

#### Structured Logging Pattern
- **Winston Logger**: Structured logging with contextual information
- **Error Context**: All errors logged with `at`, `message`, and relevant data
- **Notification Integration**: Critical errors routed to alerting systems

#### Graceful Degradation
- **Chain Failures**: Individual chain failures don't stop other chains
- **Profitability Checks**: Unprofitable fills skipped rather than causing errors
- **Rate Limiting**: Built-in protection against overwhelming RPC endpoints

#### Error Recovery Strategies
```typescript
// Pattern: Try-catch with specific error handling
try {
  await relayer.checkForUnfilledDepositsAndFill();
} catch (error) {
  logger.error({
    at: "Relayer#run",
    message: "Fill operation failed",
    error: error.message,
    notificationPath: "across-error"
  });
  // Continue operation, don't crash
}
```

#### Assertion-Based Validation
- **Runtime Assertions**: `assert()` statements for critical invariants
- **Configuration Validation**: Strict validation of environment variables and settings
- **Data Integrity**: Assertions on blockchain data consistency

### Authentication in src/relayer

#### Wallet-Based Authentication
- **CLI Wallet Selection**: `--wallet` parameter determines signer type
- **Supported Types**: `mnemonic`, `private-key`, `gckms`, `aws-kms`, `void`
- **Signer Construction**: `retrieveSignerFromCLIArgs()` creates ethers Signer

#### Multi-Chain Signer Management
```typescript
// Pattern: Base signer connected to chain-specific providers
const baseSigner = await retrieveSignerFromCLIArgs();
const chainSigner = baseSigner.connect(await getProvider(chainId));
```

#### Security Patterns
- **No Key Storage**: Private keys never stored in memory long-term (except aws-kms which uses KMS directly)
- **Environment Variables**: Sensitive data via ENV vars, not hardcoded
- **Provider Separation**: Each chain gets isolated provider connection
- **Transaction Signing**: All transactions signed locally, never sent unsigned
- **AWS KMS Integration**: Support for hardware security modules via AWS KMS direct signing

#### Transaction Authorization
- **Approval Management**: Automated token approvals for bridge contracts
- **Gas Management**: Dynamic gas price calculation and safety margins
- **Simulation First**: All transactions simulated before submission
- **Multi-signature Support**: Compatible with hardware wallets and KMS systems

### Cross-Chain Bridge Adapters
Bridge adapters (`src/adapter/`) handle chain-specific bridging logic:
- **bridges/** - L1→L2 bridge implementations (OpStack, Arbitrum, Polygon, etc.)
- **l2Bridges/** - L2→L1 bridge implementations
- **AdapterManager** - Orchestrates cross-chain transfers

## Environment Variables

### Force Origin Chain Repayment
The relayer supports configuration flags to force repayment on the origin chain, overriding the normal inventory management logic:

- `RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT=true` - Forces repayment on origin chain for all deposits (global setting)
- `RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT_{chainId}=true` - Forces repayment on origin chain for deposits from specific chain (chain-specific setting)

**Examples:**
```bash
# Force all deposits to use origin chain repayment
RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT=true

# Force only Polygon deposits to use origin chain repayment
RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT_137=true

# Force only Arbitrum deposits to use origin chain repayment  
RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT_42161=true
```

**Behavior:**
- Chain-specific settings take precedence over global settings
- The relayer validates that the origin chain is enabled for the token before forcing repayment
- If the origin chain is not enabled for the token, the deposit will be skipped with a warning
- Comprehensive logging is provided for debugging and monitoring when origin chain repayment is forced

## AWS KMS Configuration

The relayer supports AWS KMS for secure transaction signing without exposing private keys in memory.

### Environment Variables

```bash
# AWS KMS wallet configuration
AWS_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678
AWS_KMS_REGION=us-east-1
AWS_PROFILE=default  # Optional: AWS CLI profile to use

# Usage
node ./dist/index.js --relayer --wallet aws-kms
```

### AWS IAM Configuration

Required IAM permissions for the KMS key:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey",
        "kms:DescribeKey"
      ],
      "Resource": "arn:aws:kms:region:account:key/key-id"
    }
  ]
}
```

### Key Requirements

- **Key Type**: ECC_SECG_P256K1 (secp256k1 - Ethereum compatible)
- **Key Usage**: SIGN_VERIFY
- **Key Origin**: AWS_KMS or AWS_CLOUDHSM (for HSM-backed keys)

### Authentication Options

1. **IAM Role** (Recommended for production): Attach IAM role to EC2/ECS/Lambda
2. **AWS Profile**: Use AWS CLI profiles for local development
3. **Environment Variables**: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
4. **Instance Profile**: For EC2 instances with attached IAM roles

### Security Benefits

- **Hardware Security**: Private keys stored in AWS HSMs
- **Audit Trail**: All signing operations logged in CloudTrail
- **Access Control**: Fine-grained IAM permissions
- **Key Rotation**: AWS-managed key rotation support
- **No Key Exposure**: Private keys never leave AWS infrastructure

### Prerequisites
- Redis server required (`redis-server` + `REDIS_URL=redis://localhost:6379`)
- Node.js >=20.18.0
- Proper wallet configuration for transaction signing

### Test Structure
- Tests in `test/` directory mirror `src/` structure
- Uses Hardhat for testing framework
- Mock clients in `test/mocks/` for isolated testing
- Fixture data in `test/fixtures/`

### Important Patterns
- All clients update via `.update()` methods before use
- Profitability calculations determine which deposits to fill
- Cross-chain state synchronization via hub/spoke pool architecture
- Event-driven architecture with comprehensive event filtering