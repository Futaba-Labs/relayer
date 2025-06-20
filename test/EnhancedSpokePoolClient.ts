import { expect } from "chai";
import sinon from "sinon";
import { Contract } from "ethers";
import winston from "winston";
import { clients } from "@across-protocol/sdk";
import { EnhancedSpokePoolClient, BackwardSearchOptions } from "../src/clients/EnhancedSpokePoolClient";
import { BackwardEventSearcher } from "../src/utils/BackwardEventSearcher";
import { Log } from "../src/interfaces";

describe("EnhancedSpokePoolClient", () => {
  let client: EnhancedSpokePoolClient;
  let mockSpokePool: sinon.SinonStubbedInstance<Contract>;
  let mockHubPoolClient: sinon.SinonStubbedInstance<clients.HubPoolClient>;
  let logger: winston.Logger;
  let chainId: number;
  let deploymentBlock: number;

  beforeEach(() => {
    logger = winston.createLogger({
      level: "debug",
      transports: [new winston.transports.Console({ silent: true })],
    });
    
    chainId = 10; // Optimism
    deploymentBlock = 1000;
    
    mockSpokePool = sinon.createStubInstance(Contract);
    mockSpokePool.provider = {
      getBlockNumber: sinon.stub().resolves(2000),
      getBlock: sinon.stub().resolves({ timestamp: Math.floor(Date.now() / 1000) }),
    } as any;
    
    mockSpokePool.address = "0x1234567890123456789012345678901234567890";
    mockSpokePool.signer = {} as any;

    mockHubPoolClient = sinon.createStubInstance(clients.HubPoolClient);
    mockHubPoolClient.logger = logger;

    // Initialize the enhanced client
    client = new EnhancedSpokePoolClient(
      logger,
      mockSpokePool,
      mockHubPoolClient,
      chainId,
      deploymentBlock,
      { from: deploymentBlock },
      { path: "/mock/path" }
    );

    // Mock the parent class methods
    sinon.stub(client as any, "_update").resolves({
      success: true,
      currentTime: Date.now() / 1000,
      searchEndBlock: 2000,
      events: [[], []], // Two empty arrays for FundsDeposited and FilledRelay
    });

    sinon.stub(client as any, "_queryableEventNames").returns(["FundsDeposited", "FilledRelay"]);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("updateWithBackwardSearch", () => {
    it("should use backward search when enabled", async () => {
      const mockEvents: Log[] = [
        {
          event: "FundsDeposited",
          blockNumber: 1950,
          logIndex: 0,
          transactionHash: "0x123",
          transactionIndex: 0,
          blockHash: "0xabc",
          args: { depositor: "0xdepositor", amount: "1000" },
        } as Log,
      ];

      // Mock the backward searcher
      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.searchBackward.resolves({
        events: mockEvents,
        searchedToBlock: 1500,
        totalBlocksSearched: 500,
        cacheHits: 2,
        searchTimeMs: 1200,
      });

      (client as any).backwardSearcher = mockSearcher;

      const options: BackwardSearchOptions = {
        useAdaptiveSearch: true,
        lookbackBlocks: 1000,
        maxEvents: 100,
      };

      const result = await client.updateWithBackwardSearch(["FundsDeposited"], options);

      expect(result.success).to.be.true;
      expect(result.searchMethod).to.equal("backward");
      expect(result.backwardSearchResult).to.exist;
      expect(result.backwardSearchResult!.events).to.have.length(1);
      expect(mockSearcher.searchBackward).to.have.been.calledOnce;
    });

    it("should use hybrid search when configured", async () => {
      const recentEvents: Log[] = [
        {
          event: "FundsDeposited",
          blockNumber: 1980,
          logIndex: 0,
          transactionHash: "0x456",
          transactionIndex: 0,
          blockHash: "0xdef",
          args: {},
        } as Log,
      ];

      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.searchBackward.resolves({
        events: recentEvents,
        searchedToBlock: 1500,
        totalBlocksSearched: 200,
        cacheHits: 1,
        searchTimeMs: 800,
      });

      (client as any).backwardSearcher = mockSearcher;

      // Mock the should use backward search to return false (triggers hybrid)
      sinon.stub(client as any, "shouldUseBackwardSearch").returns(false);

      const options: BackwardSearchOptions = {
        useAdaptiveSearch: true,
        lookbackBlocks: 1000,
        maxEvents: 100,
      };

      const result = await client.updateWithBackwardSearch(["FundsDeposited", "FilledRelay"], options);

      expect(result.success).to.be.true;
      expect(result.searchMethod).to.equal("hybrid");
      expect(mockSearcher.searchBackward).to.have.been.calledOnce;
      expect((client as any)._update).to.have.been.calledOnce; // Forward search was also called
    });

    it("should fall back to forward search when backward search disabled", async () => {
      const options: BackwardSearchOptions = {
        useAdaptiveSearch: false,
        lookbackBlocks: 1000,
        maxEvents: 100,
      };

      const result = await client.updateWithBackwardSearch(["FundsDeposited"], options);

      expect(result.success).to.be.true;
      expect(result.searchMethod).to.equal("forward");
      expect(result.backwardSearchResult).to.be.undefined;
      expect((client as any)._update).to.have.been.calledOnce;
    });

    it("should handle backward search failures gracefully", async () => {
      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.searchBackward.rejects(new Error("RPC failure"));

      (client as any).backwardSearcher = mockSearcher;

      const options: BackwardSearchOptions = {
        useAdaptiveSearch: true,
        lookbackBlocks: 1000,
        maxEvents: 100,
      };

      const result = await client.updateWithBackwardSearch(["FundsDeposited"], options);

      expect(result.success).to.be.true;
      expect(result.searchMethod).to.equal("forward");
      expect((client as any)._update).to.have.been.calledOnce; // Fallback was used
    });

    it("should deduplicate events in hybrid mode", async () => {
      const duplicateEvent: Log = {
        event: "FundsDeposited",
        blockNumber: 1950,
        logIndex: 0,
        transactionHash: "0x123",
        transactionIndex: 0,
        blockHash: "0xabc",
        args: {},
      } as Log;

      const backwardEvents = [duplicateEvent];
      const forwardEvents = [duplicateEvent]; // Same event from forward search

      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.searchBackward.resolves({
        events: backwardEvents,
        searchedToBlock: 1500,
        totalBlocksSearched: 200,
        cacheHits: 0,
        searchTimeMs: 600,
      });

      (client as any).backwardSearcher = mockSearcher;

      // Mock forward search to return the same event
      (client as any)._update.resolves({
        success: true,
        currentTime: Date.now() / 1000,
        searchEndBlock: 2000,
        events: [forwardEvents, []], // FundsDeposited, FilledRelay
      });

      sinon.stub(client as any, "shouldUseBackwardSearch").returns(false);

      const options: BackwardSearchOptions = {
        useAdaptiveSearch: true,
        lookbackBlocks: 1000,
        maxEvents: 100,
      };

      const result = await client.updateWithBackwardSearch(["FundsDeposited", "FilledRelay"], options);

      expect(result.success).to.be.true;
      expect(result.searchMethod).to.equal("hybrid");
      
      // Should have deduplicated the events
      const totalEvents = result.events![0].length; // FundsDeposited events
      expect(totalEvents).to.equal(1); // Should be deduplicated to 1 event
    });
  });

  describe("findMostRecentDeposit", () => {
    it("should find the most recent deposit", async () => {
      const mockDeposit: Log = {
        event: "FundsDeposited",
        blockNumber: 1990,
        logIndex: 2,
        transactionHash: "0xrecent",
        transactionIndex: 1,
        blockHash: "0xlatest",
        args: {
          depositor: "0xuser",
          amount: "5000",
          messageHash: "0xmessage",
        },
      } as Log;

      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.findMostRecentEvent.resolves(mockDeposit);

      (client as any).backwardSearcher = mockSearcher;

      const result = await client.findMostRecentDeposit(1000);

      expect(result).to.exist;
      expect(result!.blockNumber).to.equal(1990);
      expect(result!.event).to.equal("FundsDeposited");
      expect(mockSearcher.findMostRecentEvent).to.have.been.calledWith(
        2000, // latest block
        sinon.match({
          eventsToFind: ["FundsDeposited"],
          maxBlocksBack: 1000,
        })
      );
    });

    it("should filter by depositor address", async () => {
      const depositorAddress = "0x1234567890123456789012345678901234567890";
      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.findMostRecentEvent.resolves(null);

      (client as any).backwardSearcher = mockSearcher;

      await client.findMostRecentDeposit(1000, depositorAddress);

      expect(mockSearcher.findMostRecentEvent).to.have.been.calledWith(
        2000,
        sinon.match({
          filterArgs: { FundsDeposited: [depositorAddress] },
        })
      );
    });

    it("should return null when no deposits found", async () => {
      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.findMostRecentEvent.resolves(null);

      (client as any).backwardSearcher = mockSearcher;

      const result = await client.findMostRecentDeposit(1000);

      expect(result).to.be.null;
    });
  });

  describe("findRecentDepositsForToken", () => {
    it("should find deposits for specific token", async () => {
      const tokenAddress = "0xA0b86a33E6441e55BF0f04b0";
      const mockDeposits: Log[] = [
        {
          event: "FundsDeposited",
          blockNumber: 1980,
          logIndex: 0,
          transactionHash: "0x1",
          transactionIndex: 0,
          blockHash: "0xa",
          args: { inputToken: tokenAddress },
        } as Log,
        {
          event: "FundsDeposited",
          blockNumber: 1970,
          logIndex: 1,
          transactionHash: "0x2",
          transactionIndex: 0,
          blockHash: "0xb",
          args: { inputToken: tokenAddress },
        } as Log,
      ];

      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.findEventsInTimeWindow.resolves({
        events: mockDeposits,
        searchedToBlock: 1500,
        totalBlocksSearched: 500,
        cacheHits: 0,
        searchTimeMs: 1500,
      });

      (client as any).backwardSearcher = mockSearcher;

      const result = await client.findRecentDepositsForToken(tokenAddress, 3600);

      expect(result).to.have.length(2);
      expect(result[0].blockNumber).to.equal(1980);
      expect(result[1].blockNumber).to.equal(1970);
      expect(mockSearcher.findEventsInTimeWindow).to.have.been.calledWith(
        2000, // latest block
        3600, // max age seconds
        sinon.match({
          filterArgs: {
            FundsDeposited: [null, null, tokenAddress], // [depositor, recipient, inputToken]
          },
        })
      );
    });

    it("should handle empty results", async () => {
      const tokenAddress = "0xA0b86a33E6441e55BF0f04b0";
      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.findEventsInTimeWindow.resolves({
        events: [],
        searchedToBlock: 1500,
        totalBlocksSearched: 500,
        cacheHits: 1,
        searchTimeMs: 800,
      });

      (client as any).backwardSearcher = mockSearcher;

      const result = await client.findRecentDepositsForToken(tokenAddress, 3600);

      expect(result).to.have.length(0);
    });
  });

  describe("getSearchStatistics", () => {
    it("should return current statistics", () => {
      // Set some test values
      (client as any).lastBackwardSearchTime = 1234567890;
      (client as any).consecutiveFailures = 2;
      (client as any).pendingEvents = [["event1"], [], ["event2", "event3"]]; // 3 events total

      const stats = client.getSearchStatistics();

      expect(stats.lastBackwardSearchTime).to.equal(1234567890);
      expect(stats.consecutiveFailures).to.equal(2);
      expect(stats.chainId).to.equal(chainId);
      expect(stats.deploymentBlock).to.equal(deploymentBlock);
      expect(stats.pendingEventsCount).to.equal(3);
    });
  });

  describe("shouldUseBackwardSearch logic", () => {
    it("should use backward search on first run", () => {
      (client as any).pendingBlockNumber = deploymentBlock; // Still at deployment block
      (client as any).lastBackwardSearchTime = 0;

      const shouldUse = (client as any).shouldUseBackwardSearch(2000);

      expect(shouldUse).to.be.true;
    });

    it("should use backward search after long gap", () => {
      const now = Date.now() / 1000;
      (client as any).pendingBlockNumber = 1500; // Not at deployment block
      (client as any).lastBackwardSearchTime = now - 700; // 11+ minutes ago
      (client as any).pendingEvents = [[], []]; // No pending events

      const shouldUse = (client as any).shouldUseBackwardSearch(2000);

      expect(shouldUse).to.be.true;
    });

    it("should not use backward search when recent search occurred", () => {
      const now = Date.now() / 1000;
      (client as any).pendingBlockNumber = 1500;
      (client as any).lastBackwardSearchTime = now - 300; // 5 minutes ago
      (client as any).pendingEvents = [["event"], []]; // Has pending events

      const shouldUse = (client as any).shouldUseBackwardSearch(2000);

      expect(shouldUse).to.be.false;
    });
  });

  describe("fallback behavior", () => {
    it("should fall back after consecutive failures", () => {
      (client as any).consecutiveFailures = 5; // Exceeds maxConsecutiveFailures (3)

      const shouldFallback = (client as any).shouldUseFallbackMethod();

      expect(shouldFallback).to.be.true;
    });

    it("should not fall back with few failures", () => {
      (client as any).consecutiveFailures = 1;

      const shouldFallback = (client as any).shouldUseFallbackMethod();

      expect(shouldFallback).to.be.false;
    });

    it("should reset failure count on successful backward search", async () => {
      const mockSearcher = sinon.createStubInstance(BackwardEventSearcher);
      mockSearcher.searchBackward.resolves({
        events: [],
        searchedToBlock: 1500,
        totalBlocksSearched: 500,
        cacheHits: 0,
        searchTimeMs: 600,
      });

      (client as any).backwardSearcher = mockSearcher;
      (client as any).consecutiveFailures = 2; // Start with some failures

      const options: BackwardSearchOptions = {
        useAdaptiveSearch: true,
        lookbackBlocks: 1000,
        maxEvents: 100,
      };

      await client.updateWithBackwardSearch(["FundsDeposited"], options);

      expect((client as any).consecutiveFailures).to.equal(0); // Should be reset
    });
  });
});