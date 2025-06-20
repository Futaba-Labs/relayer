import { expect } from "chai";
import sinon from "sinon";
import { Contract } from "ethers";
import winston from "winston";
import { BackwardEventSearcher, BackwardSearchConfig } from "../src/utils/BackwardEventSearcher";
import { Log } from "../src/interfaces";

describe("BackwardEventSearcher", () => {
  let searcher: BackwardEventSearcher;
  let mockContract: sinon.SinonStubbedInstance<Contract>;
  let mockCache: sinon.SinonStubbedInstance<any>;
  let logger: winston.Logger;
  let chainId: number;

  beforeEach(() => {
    logger = winston.createLogger({
      level: "debug",
      transports: [new winston.transports.Console({ silent: true })],
    });
    
    chainId = 1;
    
    mockContract = sinon.createStubInstance(Contract);
    mockContract.provider = {
      getBlockNumber: sinon.stub().resolves(1000),
      getBlock: sinon.stub().resolves({ timestamp: Math.floor(Date.now() / 1000) }),
    } as any;
    
    mockCache = {
      get: sinon.stub().resolves(null),
      set: sinon.stub().resolves(),
    };

    // Mock filters
    mockContract.filters = {
      FundsDeposited: sinon.stub().returns({}),
      FilledRelay: sinon.stub().returns({}),
    } as any;

    searcher = new BackwardEventSearcher(mockContract, mockCache, logger, chainId);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("searchBackward", () => {
    it("should search backwards from latest block", async () => {
      // Mock the internal fetchEventsForRange to control the test
      const mockEvents: Log[] = [
        {
          event: "FundsDeposited",
          blockNumber: 950,
          logIndex: 0,
          transactionHash: "0x123",
          transactionIndex: 0,
          blockHash: "0xabc",
          args: {},
        } as Log,
      ];

      const fetchStub = sinon.stub(searcher as any, 'fetchEventsForRange').resolves(mockEvents);

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.be.an('array');
      expect(result.totalBlocksSearched).to.be.a('number');
      expect(result.searchTimeMs).to.be.a('number');
      expect(result.cacheHits).to.be.a('number');
      expect(result.searchedToBlock).to.be.a('number');
      expect(fetchStub.callCount).to.be.greaterThan(0);
    });

    it("should handle cache correctly", async () => {
      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
        cachePrefix: "test",
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result).to.have.property('events');
      expect(result).to.have.property('totalBlocksSearched');
      expect(result).to.have.property('searchTimeMs');
      expect(result).to.have.property('cacheHits');
    });

    it("should stop early when max events reached", async () => {
      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 0, // Should return immediately
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(0);
    });

    it("should handle target block limit", async () => {
      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        targetBlock: 1000, // Same as fromBlock, should return immediately
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(0);
      expect(result.searchedToBlock).to.equal(1001);
    });

    it("should validate configuration parameters", async () => {
      const invalidConfig: BackwardSearchConfig = {
        eventsToFind: [],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: -1, // Invalid
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      try {
        await searcher.searchBackward(1000, invalidConfig);
        expect.fail("Should have thrown validation error");
      } catch (error) {
        expect(error.message).to.include("must be positive");
      }
    });

    it("should validate growth factor", async () => {
      const invalidConfig: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 0.5, // Invalid (should be >= 1)
      };

      try {
        await searcher.searchBackward(1000, invalidConfig);
        expect.fail("Should have thrown validation error");
      } catch (error) {
        expect(error.message).to.include("must be >= 1");
      }
    });

    it("should validate fromBlock vs targetBlock", async () => {
      const invalidConfig: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        targetBlock: 1100, // Greater than fromBlock
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      try {
        await searcher.searchBackward(1000, invalidConfig);
        expect.fail("Should have thrown validation error");
      } catch (error) {
        expect(error.message).to.include("fromBlock must be >= targetBlock");
      }
    });
  });

  describe("findMostRecentEvent", () => {
    it("should return the most recent event when events exist", async () => {
      const mockEvent = {
        event: "FundsDeposited",
        blockNumber: 990,
        logIndex: 0,
        transactionHash: "0x123",
        transactionIndex: 0,
        blockHash: "0xabc",
        args: {},
      } as Log;

      const searchStub = sinon.stub(searcher, 'searchBackward').resolves({
        events: [mockEvent],
        searchedToBlock: 900,
        totalBlocksSearched: 10,
        searchTimeMs: 100,
        cacheHits: 0,
      });

      const result = await searcher.findMostRecentEvent(1000, {
        eventsToFind: ["FundsDeposited"],
        maxBlocksBack: 100,
        initialChunkSize: 10,
        maxChunkSize: 100,
        chunkGrowthFactor: 2.0,
      });

      expect(result).to.deep.equal(mockEvent);
      expect(searchStub.callCount).to.equal(1);
    });

    it("should return null when no events found", async () => {
      const searchStub = sinon.stub(searcher, 'searchBackward').resolves({
        events: [],
        searchedToBlock: 900,
        totalBlocksSearched: 10,
        searchTimeMs: 100,
        cacheHits: 0,
      });

      const result = await searcher.findMostRecentEvent(1000, {
        eventsToFind: ["FundsDeposited"],
        maxBlocksBack: 100,
        initialChunkSize: 10,
        maxChunkSize: 100,
        chunkGrowthFactor: 2.0,
      });

      expect(result).to.be.null;
      expect(searchStub.callCount).to.equal(1);
    });
  });

  describe("findEventsInTimeWindow", () => {
    it("should find events within time window", async () => {
      const mockEvents = [
        {
          event: "FundsDeposited",
          blockNumber: 990,
          logIndex: 0,
          transactionHash: "0x123",
          transactionIndex: 0,
          blockHash: "0xabc",
          args: {},
        } as Log,
      ];

      // Mock getBlock to return appropriate timestamp
      (mockContract.provider as any).getBlock.resolves({ 
        timestamp: Math.floor(Date.now() / 1000) - 1800 
      }); // 30 minutes ago

      const searchStub = sinon.stub(searcher, 'searchBackward').resolves({
        events: mockEvents,
        searchedToBlock: 900,
        totalBlocksSearched: 10,
        searchTimeMs: 100,
        cacheHits: 0,
      });

      const result = await searcher.findEventsInTimeWindow(1000, 3600, {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        initialChunkSize: 10,
        maxChunkSize: 100,
        chunkGrowthFactor: 2.0,
      });

      expect(result.events).to.have.length(1);
      expect(searchStub.callCount).to.equal(1);
    });
  });

  describe("edge cases", () => {
    it("should handle zero maxEvents", async () => {
      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 0,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(0);
    });

    it("should handle fromBlock equal to targetBlock", async () => {
      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        targetBlock: 1000, // Same as fromBlock
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(0);
      expect(result.searchedToBlock).to.equal(1001);
    });

    it("should handle empty eventsToFind array", async () => {
      const config: BackwardSearchConfig = {
        eventsToFind: [], // Empty array
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(0);
    });
  });

  describe("caching", () => {
    it("should use cache when available", async () => {
      const cachedEvents = [
        {
          event: "FundsDeposited",
          blockNumber: 980,
          logIndex: 0,
          transactionHash: "0x789",
          transactionIndex: 0,
          blockHash: "0x123",
          args: {},
        } as Log,
      ];

      // Mock cache to return stringified events
      mockCache.get.resolves(JSON.stringify(cachedEvents));

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
        cachePrefix: "test",
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.cacheHits).to.be.greaterThan(0);
      expect(mockCache.get.callCount).to.be.greaterThan(0);
    });

    it("should handle cache errors gracefully", async () => {
      // Mock cache to throw error
      mockCache.get.rejects(new Error("Cache error"));

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
        cachePrefix: "test",
      };

      // Should not throw error, should continue without cache
      const result = await searcher.searchBackward(1000, config);

      expect(result).to.have.property('events');
      expect(result.cacheHits).to.equal(0);
    });
  });
});