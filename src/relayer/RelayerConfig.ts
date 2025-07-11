import { utils as ethersUtils } from "ethers";
import winston from "winston";
import { typeguards } from "@across-protocol/sdk";
import {
  BigNumber,
  bnUint256Max,
  chainIsSvm,
  CHAIN_IDs,
  dedupArray,
  toBNWei,
  assert,
  getNetworkName,
  isDefined,
  readFileSync,
  toBN,
  replaceAddressCase,
  ethers,
  TESTNET_CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  Address,
  toAddressType,
  EvmAddress,
} from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import * as Constants from "../common/Constants";
import { InventoryConfig, TokenBalanceConfig, isAliasConfig } from "../interfaces/InventoryManagement";

type DepositConfirmationConfig = {
  usdThreshold: BigNumber;
  minConfirmations: number;
};

type ChainBackwardSearchConfig = {
  enabled: boolean;
  lookbackBlocks: number;
  maxEvents: number;
  chunkSize: number;
  maxChunkSize: number;
  growthFactor: number;
  cacheEnabled: boolean;
  maxTimeMs: number;
  useHybridSearch: boolean;
};

export class RelayerConfig extends CommonConfig {
  readonly externalListener: boolean;
  readonly listenerPath: { [chainId: number]: string } = {};
  readonly inventoryConfig: InventoryConfig;
  readonly debugProfitability: boolean;
  readonly sendingRelaysEnabled: boolean;
  readonly sendingRebalancesEnabled: boolean;
  readonly sendingMessageRelaysEnabled: boolean;
  readonly sendingSlowRelaysEnabled: boolean;
  readonly relayerTokens: EvmAddress[];
  readonly relayerOriginChains: number[] = [];
  readonly relayerDestinationChains: number[] = [];
  readonly relayerGasPadding: BigNumber;
  readonly relayerGasMultiplier: BigNumber;
  readonly relayerMessageGasMultiplier: BigNumber;
  readonly minRelayerFeePct: BigNumber;
  readonly minFillTime: { [chainId: number]: number } = {};
  readonly acceptInvalidFills: boolean;
  // List of depositors we only want to send slow fills for.
  readonly slowDepositors: Address[];
  // Following distances in blocks to guarantee finality on each chain.
  readonly minDepositConfirmations: {
    [chainId: number]: DepositConfirmationConfig[];
  };
  // The amount of runs the looping relayer will make before it logs shortfalls and unprofitable fills again. If set to the one-shot
  // relayer, then this environment variable will do nothing.
  readonly loggingInterval: number;

  // Maintenance interval (in seconds).
  readonly maintenanceInterval: number;

  // Set to false to skip querying max deposit limit from /limits Vercel API endpoint. Otherwise relayer will not
  // fill any deposit over the limit which is based on liquidReserves in the HubPool.
  readonly ignoreLimits: boolean;
  // Set to all chain ids where the relayer should use tryMulticall over multicall on the associated spoke pool.
  // It is up to the user to ensure that the spoke pool on the target chain has tryMulticall in its active implementation.
  readonly tryMulticallChains: number[];

  // TODO: Remove this config item once we fully move to generic chain adapters.
  readonly useGenericAdapter: boolean;

  // SpokePoolClient update specific lookback time in seconds (default: 30 minutes)
  readonly spokePoolUpdateLookback: number;

  // Backward event search configuration (global defaults)
  readonly enableBackwardSearch: boolean;
  readonly backwardSearchLookback: number;
  readonly backwardSearchMaxEvents: number;
  readonly backwardSearchChunkSize: number;
  readonly backwardSearchMaxChunkSize: number;
  readonly backwardSearchGrowthFactor: number;
  readonly backwardSearchCacheEnabled: boolean;
  readonly backwardSearchMaxTimeMs: number;
  readonly useHybridSearch: boolean;

  // Per-chain backward search configuration
  readonly backwardSearchConfigPerChain: { [chainId: number]: ChainBackwardSearchConfig } = {};

  // Force origin chain repayment configuration
  readonly forceOriginChainRepayment: boolean;
  readonly forceOriginChainRepaymentPerChain: { [chainId: number]: boolean } = {};

  // Store environment for per-chain configuration loading
  private readonly env: ProcessEnv;

  constructor(env: ProcessEnv) {
    super(env);
    this.env = env;
    const {
      RELAYER_ORIGIN_CHAINS,
      RELAYER_DESTINATION_CHAINS,
      SLOW_DEPOSITORS,
      DEBUG_PROFITABILITY,
      RELAYER_GAS_MESSAGE_MULTIPLIER,
      RELAYER_GAS_MULTIPLIER,
      RELAYER_GAS_PADDING,
      RELAYER_EXTERNAL_INVENTORY_CONFIG,
      RELAYER_INVENTORY_CONFIG,
      RELAYER_TOKENS,
      SEND_RELAYS,
      SEND_REBALANCES,
      SEND_MESSAGE_RELAYS,
      SEND_SLOW_RELAYS,
      MIN_RELAYER_FEE_PCT,
      ACCEPT_INVALID_FILLS,
      MIN_DEPOSIT_CONFIRMATIONS,
      RELAYER_IGNORE_LIMITS,
      RELAYER_EXTERNAL_LISTENER,
      RELAYER_TRY_MULTICALL_CHAINS,
      RELAYER_LOGGING_INTERVAL = "30",
      RELAYER_MAINTENANCE_INTERVAL = "60",
      SPOKEPOOL_UPDATE_LOOKBACK,
      RELAYER_ENABLE_BACKWARD_SEARCH,
      RELAYER_BACKWARD_SEARCH_LOOKBACK,
      RELAYER_BACKWARD_SEARCH_MAX_EVENTS,
      RELAYER_BACKWARD_SEARCH_CHUNK_SIZE,
      RELAYER_BACKWARD_SEARCH_MAX_CHUNK_SIZE,
      RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR,
      RELAYER_BACKWARD_SEARCH_CACHE_ENABLED,
      RELAYER_BACKWARD_SEARCH_MAX_TIME_MS,
      RELAYER_USE_HYBRID_SEARCH,
      RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT,
    } = env;

    // External listeners are dependent on looping mode being configured.
    this.externalListener = this.pollingDelay > 0 && RELAYER_EXTERNAL_LISTENER === "true";

    // Empty means all chains.
    this.relayerOriginChains = JSON.parse(RELAYER_ORIGIN_CHAINS ?? "[]");
    this.relayerDestinationChains = JSON.parse(RELAYER_DESTINATION_CHAINS ?? "[]");

    // Empty means all tokens.
    this.relayerTokens = JSON.parse(RELAYER_TOKENS ?? "[]").map((token) =>
      toAddressType(ethers.utils.getAddress(token), CHAIN_IDs.MAINNET)
    );
    this.slowDepositors = JSON.parse(SLOW_DEPOSITORS ?? "[]").map((depositor) =>
      toAddressType(ethers.utils.getAddress(depositor), CHAIN_IDs.MAINNET)
    );

    this.minRelayerFeePct = toBNWei(MIN_RELAYER_FEE_PCT || Constants.RELAYER_MIN_FEE_PCT);

    this.tryMulticallChains = JSON.parse(RELAYER_TRY_MULTICALL_CHAINS ?? "[]");
    this.loggingInterval = Number(RELAYER_LOGGING_INTERVAL);
    this.maintenanceInterval = Number(RELAYER_MAINTENANCE_INTERVAL);

    assert(
      !isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG) || !isDefined(RELAYER_INVENTORY_CONFIG),
      "Concurrent inventory management configurations detected."
    );
    try {
      this.inventoryConfig = isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG)
        ? JSON.parse(readFileSync(RELAYER_EXTERNAL_INVENTORY_CONFIG))
        : JSON.parse(RELAYER_INVENTORY_CONFIG ?? "{}");
    } catch (err) {
      const msg = typeguards.isError(err) ? err.message : (err as Record<string, unknown>)?.code;
      throw new Error(`Inventory config error (${msg ?? "unknown error"})`);
    }

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.

      const { inventoryConfig } = this;

      // Default to 1 Eth on the target chains and wrapping the rest to WETH.
      inventoryConfig.wrapEtherThreshold = toBNWei(inventoryConfig.wrapEtherThreshold ?? 1);

      inventoryConfig.wrapEtherThresholdPerChain ??= {};
      inventoryConfig.wrapEtherTarget = inventoryConfig.wrapEtherTarget
        ? toBNWei(inventoryConfig.wrapEtherTarget)
        : inventoryConfig.wrapEtherThreshold; // default to wrapping ETH to threshold, same as target.

      inventoryConfig.wrapEtherTargetPerChain ??= {};
      assert(
        inventoryConfig.wrapEtherThreshold.gte(inventoryConfig.wrapEtherTarget),
        `default wrapEtherThreshold ${inventoryConfig.wrapEtherThreshold} must be >= default wrapEtherTarget ${inventoryConfig.wrapEtherTarget}`
      );

      // Validate the per chain target and thresholds for wrapping ETH:
      const wrapThresholds = inventoryConfig.wrapEtherThresholdPerChain;
      const wrapTargets = inventoryConfig.wrapEtherTargetPerChain;
      Object.keys(inventoryConfig.wrapEtherThresholdPerChain).forEach((chainId) => {
        if (wrapThresholds[chainId] !== undefined) {
          wrapThresholds[chainId] = toBNWei(wrapThresholds[chainId]); // Promote to 18 decimals.
        }
      });

      Object.keys(inventoryConfig.wrapEtherTargetPerChain).forEach((chainId) => {
        if (wrapTargets[chainId] !== undefined) {
          wrapTargets[chainId] = toBNWei(wrapTargets[chainId]); // Promote to 18 decimals.

          // Check newly set target against threshold
          const threshold = wrapThresholds[chainId] ?? inventoryConfig.wrapEtherThreshold;
          const target = wrapTargets[chainId];
          assert(
            threshold.gte(target),
            `Chain ${chainId} wrapEtherThresholdPerChain ${threshold} must be >= wrapEtherTargetPerChain ${target}`
          );
        }
      });

      const parseTokenConfig = (
        l1Token: string,
        chainId: string,
        rawTokenConfig: TokenBalanceConfig
      ): TokenBalanceConfig => {
        const {
          targetPct,
          thresholdPct,
          unwrapWethThreshold,
          unwrapWethTarget,
          targetOverageBuffer,
          withdrawExcessPeriod,
        } = rawTokenConfig;
        const tokenConfig: TokenBalanceConfig = {
          targetPct,
          thresholdPct,
          targetOverageBuffer,
          withdrawExcessPeriod,
        };

        assert(
          targetPct !== undefined && thresholdPct !== undefined,
          `Bad config. Must specify targetPct, thresholdPct for ${l1Token} on ${chainId}`
        );
        assert(
          toBN(thresholdPct).lte(toBN(targetPct)),
          `Bad config. thresholdPct<=targetPct for ${l1Token} on ${chainId}`
        );
        tokenConfig.targetPct = toBNWei(targetPct).div(100);
        tokenConfig.thresholdPct = toBNWei(thresholdPct).div(100);

        tokenConfig.withdrawExcessPeriod = withdrawExcessPeriod;

        // Default to 150% the targetPct. targetOverageBuffer does not have to be defined so that no existing configs
        // are broken. This is a reasonable default because it allows the relayer to be a bit more flexible in
        // holding more tokens than the targetPct, but perhaps a better default is 100%
        tokenConfig.targetOverageBuffer = toBNWei(targetOverageBuffer ?? "1.5");
        assert(tokenConfig.targetOverageBuffer.gte(toBNWei("1.0")), "targetOverageBuffer must be >= 1.0x");

        // For WETH, also consider any unwrap target/threshold.
        if (l1Token === TOKEN_SYMBOLS_MAP.WETH.symbol) {
          if (unwrapWethThreshold !== undefined) {
            tokenConfig.unwrapWethThreshold = toBNWei(unwrapWethThreshold);
          }
          tokenConfig.unwrapWethTarget = toBNWei(unwrapWethTarget ?? 2);
        }

        return tokenConfig;
      };

      const rawTokenConfigs = inventoryConfig?.tokenConfig ?? {};
      const tokenConfigs = (inventoryConfig.tokenConfig = {});
      Object.keys(rawTokenConfigs).forEach((l1Token) => {
        // If the l1Token is a symbol, resolve the correct address.
        const effectiveL1Token = ethersUtils.isAddress(l1Token)
          ? ethersUtils.getAddress(l1Token)
          : TOKEN_SYMBOLS_MAP[l1Token].addresses[this.hubPoolChainId];
        assert(effectiveL1Token !== undefined, `No token identified for ${l1Token}`);

        // Filter inventory configuration by supported tokens, if specified.
        const known =
          this.relayerTokens.map((token) => token.toNative()).includes(effectiveL1Token) ||
          this.relayerTokens.length === 0;
        if (!known) {
          delete rawTokenConfigs[l1Token];
          return;
        }

        tokenConfigs[effectiveL1Token] ??= {};
        const hubTokenConfig = rawTokenConfigs[l1Token];

        if (isAliasConfig(hubTokenConfig)) {
          Object.keys(hubTokenConfig).forEach((symbol) => {
            Object.keys(hubTokenConfig[symbol]).forEach((chainId) => {
              const rawTokenConfig = hubTokenConfig[symbol][chainId];
              const effectiveSpokeToken = TOKEN_SYMBOLS_MAP[symbol].addresses[chainId];

              tokenConfigs[effectiveL1Token][effectiveSpokeToken] ??= {};
              tokenConfigs[effectiveL1Token][effectiveSpokeToken][chainId] = parseTokenConfig(
                l1Token,
                chainId,
                rawTokenConfig
              );
            });
          });
        } else {
          Object.keys(hubTokenConfig).forEach((chainId) => {
            const rawTokenConfig = hubTokenConfig[chainId];
            tokenConfigs[effectiveL1Token][chainId] = parseTokenConfig(l1Token, chainId, rawTokenConfig);
          });
        }
      });
    }

    this.debugProfitability = DEBUG_PROFITABILITY === "true";
    this.relayerGasPadding = toBNWei(RELAYER_GAS_PADDING || Constants.DEFAULT_RELAYER_GAS_PADDING);
    this.relayerGasMultiplier = toBNWei(RELAYER_GAS_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MULTIPLIER);
    this.relayerMessageGasMultiplier = toBNWei(
      RELAYER_GAS_MESSAGE_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER
    );
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingRebalancesEnabled = SEND_REBALANCES === "true";
    this.sendingMessageRelaysEnabled = SEND_MESSAGE_RELAYS === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
    this.acceptInvalidFills = ACCEPT_INVALID_FILLS === "true";

    const minDepositConfirmations = MIN_DEPOSIT_CONFIRMATIONS
      ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS)
      : Constants.MIN_DEPOSIT_CONFIRMATIONS;

    // Transform deposit confirmation requirements into an array of ascending
    // deposit confirmations, sorted by the corresponding threshold in USD.
    this.minDepositConfirmations = {};
    if (this.hubPoolChainId !== CHAIN_IDs.MAINNET && !isDefined(MIN_DEPOSIT_CONFIRMATIONS)) {
      // Sub in permissive defaults for testnet.
      const standardConfig = { usdThreshold: toBNWei(Number.MAX_SAFE_INTEGER), minConfirmations: 1 };
      Object.values(TESTNET_CHAIN_IDs).forEach((chainId) => (this.minDepositConfirmations[chainId] = [standardConfig]));
    } else {
      Object.keys(minDepositConfirmations)
        .map((_threshold) => {
          const threshold = Number(_threshold);
          assert(!isNaN(threshold) && threshold >= 0, `Invalid deposit confirmation threshold (${_threshold})`);
          return threshold;
        })
        .sort((x, y) => x - y)
        .forEach((usdThreshold) => {
          const config = minDepositConfirmations[usdThreshold];

          Object.entries(config).forEach(([chainId, _minConfirmations]) => {
            const minConfirmations = Number(_minConfirmations);
            assert(
              !isNaN(minConfirmations) && minConfirmations >= 0,
              `${getNetworkName(chainId)} deposit confirmations for` +
                ` ${usdThreshold} threshold missing or invalid (${_minConfirmations}).`
            );

            this.minDepositConfirmations[chainId] ??= [];
            this.minDepositConfirmations[chainId].push({ usdThreshold: toBNWei(usdThreshold), minConfirmations });
          });
        });

      // Ensure that there is always a deposit confirmation config for the maximum theoretical value of a fill.
      Object.values(this.minDepositConfirmations).forEach((depositConfirmations) => {
        const { usdThreshold: maxThreshold, minConfirmations: maxConfirmations } = depositConfirmations.at(-1);
        if (maxThreshold.lt(bnUint256Max)) {
          depositConfirmations.push({
            usdThreshold: bnUint256Max,
            minConfirmations: maxConfirmations + 1,
          });
        }
      });

      // Verify that each successive USD threshold has an increasing deposit confirmation config.
      Object.values(this.minDepositConfirmations).forEach((chainMDC) => {
        chainMDC.slice(1).forEach(({ usdThreshold, minConfirmations: mdc }, idx) => {
          const usdFormatted = ethersUtils.formatEther(usdThreshold);
          const prevMDC = chainMDC[idx].minConfirmations;
          assert(
            mdc >= prevMDC,
            `Non-incrementing deposit confirmation specified for USD threshold ${usdFormatted} (${prevMDC} > ${mdc})`
          );
        });
      });
    }

    this.ignoreLimits = RELAYER_IGNORE_LIMITS === "true";

    this.spokePoolUpdateLookback = Number(SPOKEPOOL_UPDATE_LOOKBACK) || Constants.DEFAULT_SPOKEPOOL_UPDATE_LOOKBACK;
    assert(this.spokePoolUpdateLookback > 0, "spokePoolUpdateLookback must be greater than 0");

    // Initialize global backward search configuration (defaults)
    this.enableBackwardSearch = RELAYER_ENABLE_BACKWARD_SEARCH === "true";
    this.backwardSearchLookback = Number(RELAYER_BACKWARD_SEARCH_LOOKBACK) || 10000; // blocks
    this.backwardSearchMaxEvents = Number(RELAYER_BACKWARD_SEARCH_MAX_EVENTS) || 1000;
    this.backwardSearchChunkSize = Number(RELAYER_BACKWARD_SEARCH_CHUNK_SIZE) || 500;
    this.backwardSearchMaxChunkSize = Number(RELAYER_BACKWARD_SEARCH_MAX_CHUNK_SIZE) || 5000;
    this.backwardSearchGrowthFactor = Number(RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR) || 2.0;
    this.backwardSearchCacheEnabled = RELAYER_BACKWARD_SEARCH_CACHE_ENABLED !== "false"; // Default true
    this.backwardSearchMaxTimeMs = Number(RELAYER_BACKWARD_SEARCH_MAX_TIME_MS) || 30000; // 30 seconds
    this.useHybridSearch = RELAYER_USE_HYBRID_SEARCH === "true";

    // Validation for global backward search config
    assert(this.backwardSearchLookback > 0, "backwardSearchLookback must be greater than 0");
    assert(this.backwardSearchMaxEvents > 0, "backwardSearchMaxEvents must be greater than 0");
    assert(this.backwardSearchChunkSize > 0, "backwardSearchChunkSize must be greater than 0");
    assert(
      this.backwardSearchMaxChunkSize >= this.backwardSearchChunkSize,
      "backwardSearchMaxChunkSize must be >= backwardSearchChunkSize"
    );
    assert(this.backwardSearchGrowthFactor >= 1.0, "backwardSearchGrowthFactor must be >= 1.0");
    assert(this.backwardSearchMaxTimeMs > 0, "backwardSearchMaxTimeMs must be greater than 0");

    // Initialize force origin chain repayment configuration
    this.forceOriginChainRepayment = RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT === "true";
  }

  /**
   * @notice Load per-chain backward search configuration from environment variables
   * @param chainIds Array of chain IDs to configure
   * @param logger Logger instance for debugging
   */
  private loadPerChainBackwardSearchConfig(chainIds: number[], logger: winston.Logger): void {
    chainIds.forEach((chainId) => {
      const chainName = getNetworkName(chainId);

      // Load per-chain configuration with fallback to global defaults
      const enabled = this.env[`RELAYER_BACKWARD_SEARCH_ENABLED_${chainId}`];
      const lookback = this.env[`RELAYER_BACKWARD_SEARCH_LOOKBACK_${chainId}`];
      const maxEvents = this.env[`RELAYER_BACKWARD_SEARCH_MAX_EVENTS_${chainId}`];
      const chunkSize = this.env[`RELAYER_BACKWARD_SEARCH_CHUNK_SIZE_${chainId}`];
      const maxChunkSize = this.env[`RELAYER_BACKWARD_SEARCH_MAX_CHUNK_SIZE_${chainId}`];
      const growthFactor = this.env[`RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR_${chainId}`];
      const cacheEnabled = this.env[`RELAYER_BACKWARD_SEARCH_CACHE_ENABLED_${chainId}`];
      const maxTimeMs = this.env[`RELAYER_BACKWARD_SEARCH_MAX_TIME_MS_${chainId}`];
      const useHybrid = this.env[`RELAYER_BACKWARD_SEARCH_USE_HYBRID_${chainId}`];

      // Create chain-specific config with fallbacks to global defaults
      const chainConfig: ChainBackwardSearchConfig = {
        enabled: enabled !== undefined ? enabled === "true" : this.enableBackwardSearch,
        lookbackBlocks: lookback !== undefined ? Number(lookback) : this.backwardSearchLookback,
        maxEvents: maxEvents !== undefined ? Number(maxEvents) : this.backwardSearchMaxEvents,
        chunkSize: chunkSize !== undefined ? Number(chunkSize) : this.backwardSearchChunkSize,
        maxChunkSize: maxChunkSize !== undefined ? Number(maxChunkSize) : this.backwardSearchMaxChunkSize,
        growthFactor: growthFactor !== undefined ? Number(growthFactor) : this.backwardSearchGrowthFactor,
        cacheEnabled: cacheEnabled !== undefined ? cacheEnabled !== "false" : this.backwardSearchCacheEnabled,
        maxTimeMs: maxTimeMs !== undefined ? Number(maxTimeMs) : this.backwardSearchMaxTimeMs,
        useHybridSearch: useHybrid !== undefined ? useHybrid === "true" : this.useHybridSearch,
      };

      // Validate chain-specific configuration
      try {
        assert(chainConfig.lookbackBlocks > 0, `lookbackBlocks must be > 0 for chain ${chainId}`);
        assert(chainConfig.maxEvents > 0, `maxEvents must be > 0 for chain ${chainId}`);
        assert(chainConfig.chunkSize > 0, `chunkSize must be > 0 for chain ${chainId}`);
        assert(
          chainConfig.maxChunkSize >= chainConfig.chunkSize,
          `maxChunkSize must be >= chunkSize for chain ${chainId}`
        );
        assert(chainConfig.growthFactor >= 1.0, `growthFactor must be >= 1.0 for chain ${chainId}`);
        assert(chainConfig.maxTimeMs > 0, `maxTimeMs must be > 0 for chain ${chainId}`);

        this.backwardSearchConfigPerChain[chainId] = chainConfig;

        // Log chain-specific overrides
        const hasOverrides =
          enabled ||
          lookback ||
          maxEvents ||
          chunkSize ||
          maxChunkSize ||
          growthFactor ||
          cacheEnabled ||
          maxTimeMs ||
          useHybrid;
        if (hasOverrides && logger) {
          logger.debug({
            at: "RelayerConfig::loadPerChainBackwardSearchConfig",
            message: `Loaded backward search config for ${chainName}`,
            chainId,
            config: chainConfig,
          });
        }
      } catch (error) {
        logger.error({
          at: "RelayerConfig::loadPerChainBackwardSearchConfig",
          message: `Invalid backward search config for ${chainName}`,
          chainId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    logger.debug({
      at: "RelayerConfig::loadPerChainBackwardSearchConfig",
      message: `Loaded backward search config for ${chainIds.length} chains`,
      enabledChains: Object.entries(this.backwardSearchConfigPerChain)
        .filter(([, config]) => config.enabled)
        .map(([chainId]) => getNetworkName(Number(chainId))),
    });
  }

  /**
   * @notice Get backward search configuration for a specific chain
   * @param chainId Chain ID to get configuration for
   * @returns Chain-specific backward search configuration
   */
  getBackwardSearchConfigForChain(chainId: number): ChainBackwardSearchConfig {
    return (
      this.backwardSearchConfigPerChain[chainId] || {
        enabled: this.enableBackwardSearch,
        lookbackBlocks: this.backwardSearchLookback,
        maxEvents: this.backwardSearchMaxEvents,
        chunkSize: this.backwardSearchChunkSize,
        maxChunkSize: this.backwardSearchMaxChunkSize,
        growthFactor: this.backwardSearchGrowthFactor,
        cacheEnabled: this.backwardSearchCacheEnabled,
        maxTimeMs: this.backwardSearchMaxTimeMs,
        useHybridSearch: this.useHybridSearch,
      }
    );
  }

  /**
   * @notice Check if backward search is enabled for a specific chain
   * @param chainId Chain ID to check
   * @returns True if backward search is enabled for the chain
   */
  isBackwardSearchEnabledForChain(chainId: number): boolean {
    const config = this.getBackwardSearchConfigForChain(chainId);
    return config.enabled;
  }

  /**
   * @notice Load per-chain force origin repayment configuration from environment variables
   * @param chainIds Array of chain IDs to configure
   * @param logger Logger instance for debugging
   */
  private loadPerChainForceOriginRepaymentConfig(chainIds: number[], logger: winston.Logger): void {
    chainIds.forEach((chainId) => {
      const chainSpecificEnv = this.env[`RELAYER_FORCE_ORIGIN_CHAIN_REPAYMENT_${chainId}`];
      if (chainSpecificEnv !== undefined) {
        this.forceOriginChainRepaymentPerChain[chainId] = chainSpecificEnv === "true";

        logger.debug({
          at: "RelayerConfig::loadPerChainForceOriginRepaymentConfig",
          message: `Force origin chain repayment for chain ${chainId}`,
          chainId,
          forced: this.forceOriginChainRepaymentPerChain[chainId],
        });
      }
    });
  }

  /**
   * @notice Check if origin chain repayment should be forced for a specific chain
   * @param chainId Chain ID to check
   * @returns True if origin chain repayment should be forced
   */
  shouldForceOriginChainRepayment(chainId: number): boolean {
    // Check chain-specific setting first, then fall back to global setting
    const chainSpecific = this.forceOriginChainRepaymentPerChain[chainId];
    return chainSpecific !== undefined ? chainSpecific : this.forceOriginChainRepayment;
  }

  /**
   * @notice Loads additional configuration state that can only be known after we know all chains that we're going to
   * support. Warns or throws if any of the configurations are not valid.
   * @param chainIdIndices All expected chain ID's that could be supported by this config.
   * @param logger Optional logger object.
   */
  override validate(chainIds: number[], logger: winston.Logger): void {
    const { listenerPath, minFillTime, relayerOriginChains, relayerDestinationChains } = this;
    const relayerChainIds =
      relayerOriginChains.length > 0 && relayerDestinationChains.length > 0
        ? dedupArray([...relayerOriginChains, ...relayerDestinationChains])
        : chainIds;

    const ignoredChainIds = chainIds.filter(
      (chainId) => !relayerChainIds.includes(chainId) && chainId !== CHAIN_IDs.BOBA
    );
    if (ignoredChainIds.length > 0 && logger) {
      logger.debug({
        at: "RelayerConfig::validate",
        message: `Ignoring ${ignoredChainIds.length} chains.`,
        ignoredChainIds,
      });
    }

    chainIds.forEach((chainId) => {
      const defaultPath = chainIsSvm(chainId)
        ? Constants.RELAYER_SPOKEPOOL_LISTENER_SVM
        : Constants.RELAYER_SPOKEPOOL_LISTENER_EVM;
      const { RELAYER_SPOKEPOOL_LISTENER_PATH = defaultPath } = process.env;
      minFillTime[chainId] = Number(process.env[`RELAYER_MIN_FILL_TIME_${chainId}`] ?? 0);
      listenerPath[chainId] =
        process.env[`RELAYER_SPOKEPOOL_LISTENER_PATH_${chainId}`] ?? RELAYER_SPOKEPOOL_LISTENER_PATH;
    });

    // Load per-chain backward search configuration
    this.loadPerChainBackwardSearchConfig(relayerChainIds, logger);

    // Load per-chain force origin repayment configuration
    this.loadPerChainForceOriginRepaymentConfig(chainIds, logger);

    // Only validate config for chains that the relayer cares about.
    super.validate(relayerChainIds, logger);
  }
}
