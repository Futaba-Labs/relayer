import { expect } from "chai";
import sinon from "sinon";
import winston from "winston";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { EnhancedSpokePoolClient } from "../src/clients/EnhancedSpokePoolClient";
import { Contract } from "ethers";
import { clients } from "@across-protocol/sdk";

describe("Per-Chain Backward Search Configuration", () => {
  let logger: winston.Logger;
  let mockEnv: { [key: string]: string };

  beforeEach(() => {
    logger = winston.createLogger({
      level: "debug",
      transports: [new winston.transports.Console({ silent: true })],
    });

    // Set up basic environment variables
    mockEnv = {
      HUB_CHAIN_ID: "1",
      RELAYER_EXTERNAL_INVENTORY_CONFIG: undefined,
      RELAYER_INVENTORY_CONFIG: "{}",
      SPOKEPOOL_UPDATE_LOOKBACK: "1800",
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("RelayerConfig Per-Chain Settings", () => {
    it("should use global defaults when no per-chain config is set", () => {
      const config = new RelayerConfig(mockEnv);
      config.validate([1, 10, 137], logger);

      // Test Ethereum (chainId: 1)
      const ethConfig = config.getBackwardSearchConfigForChain(1);
      expect(ethConfig.enabled).to.equal(config.enableBackwardSearch);
      expect(ethConfig.lookbackBlocks).to.equal(config.backwardSearchLookback);
      expect(ethConfig.maxEvents).to.equal(config.backwardSearchMaxEvents);
      expect(ethConfig.chunkSize).to.equal(config.backwardSearchChunkSize);
    });

    it("should apply per-chain overrides correctly", () => {
      const envWithChainOverrides = {
        ...mockEnv,
        // Global settings
        RELAYER_ENABLE_BACKWARD_SEARCH: "true",
        RELAYER_BACKWARD_SEARCH_LOOKBACK: "10000",
        RELAYER_BACKWARD_SEARCH_MAX_EVENTS: "1000",
        RELAYER_BACKWARD_SEARCH_CHUNK_SIZE: "500",

        // Optimism (chainId: 10) specific overrides
        RELAYER_BACKWARD_SEARCH_ENABLED_10: "true",
        RELAYER_BACKWARD_SEARCH_LOOKBACK_10: "20000",
        RELAYER_BACKWARD_SEARCH_MAX_EVENTS_10: "2000",
        RELAYER_BACKWARD_SEARCH_CHUNK_SIZE_10: "1000",
        RELAYER_BACKWARD_SEARCH_USE_HYBRID_10: "true",

        // Polygon (chainId: 137) specific overrides
        RELAYER_BACKWARD_SEARCH_ENABLED_137: "false", // Disabled for Polygon
        RELAYER_BACKWARD_SEARCH_LOOKBACK_137: "5000",
      };

      const config = new RelayerConfig(envWithChainOverrides);
      config.validate([1, 10, 137], logger);

      // Test Ethereum (should use global defaults)
      const ethConfig = config.getBackwardSearchConfigForChain(1);
      expect(ethConfig.enabled).to.be.true;
      expect(ethConfig.lookbackBlocks).to.equal(10000);
      expect(ethConfig.maxEvents).to.equal(1000);
      expect(ethConfig.chunkSize).to.equal(500);
      expect(ethConfig.useHybridSearch).to.be.false;

      // Test Optimism (should use per-chain overrides)
      const optimismConfig = config.getBackwardSearchConfigForChain(10);
      expect(optimismConfig.enabled).to.be.true;
      expect(optimismConfig.lookbackBlocks).to.equal(20000);
      expect(optimismConfig.maxEvents).to.equal(2000);
      expect(optimismConfig.chunkSize).to.equal(1000);
      expect(optimismConfig.useHybridSearch).to.be.true;

      // Test Polygon (should have backward search disabled)
      const polygonConfig = config.getBackwardSearchConfigForChain(137);
      expect(polygonConfig.enabled).to.be.false;
      expect(polygonConfig.lookbackBlocks).to.equal(5000); // Override applied
      expect(polygonConfig.maxEvents).to.equal(1000); // Global default
    });

    it("should validate per-chain configuration correctly", () => {
      const invalidEnv = {
        ...mockEnv,
        RELAYER_BACKWARD_SEARCH_ENABLED_10: "true",
        RELAYER_BACKWARD_SEARCH_LOOKBACK_10: "-1000", // Invalid: negative value
      };

      expect(() => {
        const config = new RelayerConfig(invalidEnv);
        config.validate([10], logger);
      }).to.throw("lookbackBlocks must be > 0 for chain 10");
    });

    it("should check if backward search is enabled for specific chains", () => {
      const envWithMixedSettings = {
        ...mockEnv,
        RELAYER_ENABLE_BACKWARD_SEARCH: "false", // Global disabled
        RELAYER_BACKWARD_SEARCH_ENABLED_10: "true", // Optimism enabled
        RELAYER_BACKWARD_SEARCH_ENABLED_137: "false", // Polygon explicitly disabled
      };

      const config = new RelayerConfig(envWithMixedSettings);
      config.validate([1, 10, 137], logger);

      expect(config.isBackwardSearchEnabledForChain(1)).to.be.false; // Global default
      expect(config.isBackwardSearchEnabledForChain(10)).to.be.true; // Per-chain enabled
      expect(config.isBackwardSearchEnabledForChain(137)).to.be.false; // Per-chain disabled
      expect(config.isBackwardSearchEnabledForChain(999)).to.be.false; // Unknown chain, use global
    });

    it("should handle different growth factors per chain", () => {
      const envWithGrowthFactors = {
        ...mockEnv,
        RELAYER_ENABLE_BACKWARD_SEARCH: "true",
        RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR: "2.0", // Global
        RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR_10: "1.5", // Optimism
        RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR_137: "3.0", // Polygon
      };

      const config = new RelayerConfig(envWithGrowthFactors);
      config.validate([1, 10, 137], logger);

      expect(config.getBackwardSearchConfigForChain(1).growthFactor).to.equal(2.0);
      expect(config.getBackwardSearchConfigForChain(10).growthFactor).to.equal(1.5);
      expect(config.getBackwardSearchConfigForChain(137).growthFactor).to.equal(3.0);
    });

    it("should handle cache settings per chain", () => {
      const envWithCacheSettings = {
        ...mockEnv,
        RELAYER_ENABLE_BACKWARD_SEARCH: "true",
        RELAYER_BACKWARD_SEARCH_CACHE_ENABLED: "true", // Global enabled
        RELAYER_BACKWARD_SEARCH_CACHE_ENABLED_10: "false", // Optimism disabled
        RELAYER_BACKWARD_SEARCH_CACHE_ENABLED_137: "true", // Polygon explicitly enabled
      };

      const config = new RelayerConfig(envWithCacheSettings);
      config.validate([1, 10, 137], logger);

      expect(config.getBackwardSearchConfigForChain(1).cacheEnabled).to.be.true;
      expect(config.getBackwardSearchConfigForChain(10).cacheEnabled).to.be.false;
      expect(config.getBackwardSearchConfigForChain(137).cacheEnabled).to.be.true;
    });
  });

  describe("EnhancedSpokePoolClient Per-Chain Configuration", () => {
    let mockSpokePool: sinon.SinonStubbedInstance<Contract>;
    let mockHubPoolClient: sinon.SinonStubbedInstance<clients.HubPoolClient>;
    let client: EnhancedSpokePoolClient;

    beforeEach(() => {
      mockSpokePool = sinon.createStubInstance(Contract);
      mockSpokePool.provider = {
        getBlockNumber: sinon.stub().resolves(2000),
        getBlock: sinon.stub().resolves({ timestamp: Math.floor(Date.now() / 1000) }),
      } as any;

      mockSpokePool.address = "0x1234567890123456789012345678901234567890";
      mockSpokePool.signer = {} as any;
      mockSpokePool.interface = {
        fragments: [],
      } as any;

      mockHubPoolClient = sinon.createStubInstance(clients.HubPoolClient);
      mockHubPoolClient.logger = logger;

      client = new EnhancedSpokePoolClient(
        logger,
        mockSpokePool,
        mockHubPoolClient,
        10, // Optimism
        1000,
        { from: 1000 },
        { path: "/mock/path" }
      );

      // Mock parent class methods
      sinon.stub(client as any, "_update").resolves({
        success: true,
        currentTime: Date.now() / 1000,
        searchEndBlock: 2000,
        events: [[], []],
      });
      sinon.stub(client as any, "_queryableEventNames").returns(["FundsDeposited", "FilledRelay"]);
    });

    it("should use chain-specific configuration when set", () => {
      const chainConfig = {
        enabled: true,
        lookbackBlocks: 15000,
        maxEvents: 500,
        chunkSize: 800,
        maxChunkSize: 4000,
        growthFactor: 1.8,
        cacheEnabled: true,
        maxTimeMs: 25000,
        useHybridSearch: true,
      };

      client.setChainConfig(chainConfig);

      const options = {
        useAdaptiveSearch: true,
        // Don't specify other options to test chain config fallback
      };

      const mergedOptions = (client as any).mergeOptionsWithChainConfig(options);

      expect(mergedOptions.lookbackBlocks).to.equal(15000);
      expect(mergedOptions.maxEvents).to.equal(500);
      expect(mergedOptions.chunkSize).to.equal(800);
      expect(mergedOptions.maxChunkSize).to.equal(4000);
      expect(mergedOptions.growthFactor).to.equal(1.8);
      expect(mergedOptions.maxSearchTimeMs).to.equal(25000);
      expect(mergedOptions.useHybridSearch).to.equal(true);
    });

    it("should prefer provided options over chain config", () => {
      const chainConfig = {
        enabled: true,
        lookbackBlocks: 15000,
        maxEvents: 500,
        chunkSize: 800,
      };

      client.setChainConfig(chainConfig);

      const options = {
        useAdaptiveSearch: true,
        lookbackBlocks: 25000, // Override chain config
        maxEvents: 1500, // Override chain config
        // chunkSize not specified, should use chain config
      };

      const mergedOptions = (client as any).mergeOptionsWithChainConfig(options);

      expect(mergedOptions.lookbackBlocks).to.equal(25000); // From options
      expect(mergedOptions.maxEvents).to.equal(1500); // From options
      expect(mergedOptions.chunkSize).to.equal(800); // From chain config
    });

    it("should not use backward search when disabled in chain config", () => {
      const disabledChainConfig = {
        enabled: false,
        lookbackBlocks: 15000,
        maxEvents: 500,
      };

      client.setChainConfig(disabledChainConfig);

      const shouldUse = (client as any).shouldUseBackwardSearch(2000);
      expect(shouldUse).to.be.false;
    });

    it("should prefer hybrid search when configured", () => {
      const hybridChainConfig = {
        enabled: true,
        lookbackBlocks: 15000,
        maxEvents: 500,
        useHybridSearch: true,
      };

      client.setChainConfig(hybridChainConfig);

      // Set up conditions that would normally trigger backward search
      (client as any).pendingBlockNumber = 1000; // deployment block
      (client as any).lastBackwardSearchTime = 0;

      const shouldUse = (client as any).shouldUseBackwardSearch(2000);
      expect(shouldUse).to.be.true; // Should still return true for first run

      // But when not first run and has recent search, should prefer hybrid
      (client as any).pendingBlockNumber = 1500; // Not at deployment
      (client as any).lastBackwardSearchTime = Date.now() / 1000 - 100; // Recent search

      const shouldUseAfter = (client as any).shouldUseBackwardSearch(2000);
      expect(shouldUseAfter).to.be.false; // Should defer to hybrid search
    });

    it("should return chain config defaults when no chain config is set", () => {
      const options = {
        useAdaptiveSearch: true,
      };

      const mergedOptions = (client as any).mergeOptionsWithChainConfig(options);

      // Should return the original options when no chain config
      expect(mergedOptions).to.deep.equal(options);
    });

    it("should handle partial chain configuration", () => {
      const partialChainConfig = {
        enabled: true,
        lookbackBlocks: 15000,
        // Other properties missing, should not cause errors
      };

      client.setChainConfig(partialChainConfig);

      const options = {
        useAdaptiveSearch: true,
        maxEvents: 1000,
      };

      const mergedOptions = (client as any).mergeOptionsWithChainConfig(options);

      expect(mergedOptions.lookbackBlocks).to.equal(15000); // From chain config
      expect(mergedOptions.maxEvents).to.equal(1000); // From options
      expect(mergedOptions.chunkSize).to.be.undefined; // Not in either
    });
  });

  describe("Integration Tests", () => {
    it("should create different client configurations for different chains", () => {
      const envWithMultiChain = {
        ...mockEnv,
        // Global settings
        RELAYER_ENABLE_BACKWARD_SEARCH: "true",
        RELAYER_BACKWARD_SEARCH_LOOKBACK: "10000",

        // Optimism specific - high performance settings
        RELAYER_BACKWARD_SEARCH_ENABLED_10: "true",
        RELAYER_BACKWARD_SEARCH_LOOKBACK_10: "20000",
        RELAYER_BACKWARD_SEARCH_CHUNK_SIZE_10: "2000",
        RELAYER_BACKWARD_SEARCH_USE_HYBRID_10: "true",

        // Polygon specific - conservative settings
        RELAYER_BACKWARD_SEARCH_ENABLED_137: "true",
        RELAYER_BACKWARD_SEARCH_LOOKBACK_137: "5000",
        RELAYER_BACKWARD_SEARCH_CHUNK_SIZE_137: "200",
        RELAYER_BACKWARD_SEARCH_GROWTH_FACTOR_137: "1.2",

        // Arbitrum specific - disabled
        RELAYER_BACKWARD_SEARCH_ENABLED_42161: "false",
      };

      const config = new RelayerConfig(envWithMultiChain);
      config.validate([1, 10, 137, 42161], logger);

      // Verify each chain has the expected configuration
      const ethConfig = config.getBackwardSearchConfigForChain(1);
      expect(ethConfig.enabled).to.be.true;
      expect(ethConfig.lookbackBlocks).to.equal(10000);
      expect(ethConfig.useHybridSearch).to.be.false;

      const optimismConfig = config.getBackwardSearchConfigForChain(10);
      expect(optimismConfig.enabled).to.be.true;
      expect(optimismConfig.lookbackBlocks).to.equal(20000);
      expect(optimismConfig.chunkSize).to.equal(2000);
      expect(optimismConfig.useHybridSearch).to.be.true;

      const polygonConfig = config.getBackwardSearchConfigForChain(137);
      expect(polygonConfig.enabled).to.be.true;
      expect(polygonConfig.lookbackBlocks).to.equal(5000);
      expect(polygonConfig.chunkSize).to.equal(200);
      expect(polygonConfig.growthFactor).to.equal(1.2);

      const arbitrumConfig = config.getBackwardSearchConfigForChain(42161);
      expect(arbitrumConfig.enabled).to.be.false;
      expect(arbitrumConfig.lookbackBlocks).to.equal(10000); // Global default
    });

    it("should handle missing chain configuration gracefully", () => {
      const config = new RelayerConfig({
        ...mockEnv,
        RELAYER_ENABLE_BACKWARD_SEARCH: "true",
        RELAYER_BACKWARD_SEARCH_LOOKBACK: "8000",
        // Use a valid JSON for BLOCK_RANGE_END_BLOCK_BUFFER
        BLOCK_RANGE_END_BLOCK_BUFFER: '{"999": 10}',
      });

      config.validate([999], logger); // Chain that doesn't exist

      const unknownChainConfig = config.getBackwardSearchConfigForChain(999);
      expect(unknownChainConfig.enabled).to.be.true;
      expect(unknownChainConfig.lookbackBlocks).to.equal(8000);
    });
  });
});
