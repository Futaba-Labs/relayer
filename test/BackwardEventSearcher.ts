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
      get: sinon.stub(),
      set: sinon.stub(),
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
        {
          event: "FilledRelay", 
          blockNumber: 940,
          logIndex: 1,
          transactionHash: "0x456",
          transactionIndex: 1,
          blockHash: "0xdef",
          args: {},
        } as Log,
      ];

      // Mock paginatedEventQuery to return events
      const paginatedEventQueryStub = sinon.stub().resolves(mockEvents);
      (searcher as any).fetchEventsForRange = paginatedEventQueryStub;

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited", "FilledRelay"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(2);
      expect(result.events[0].blockNumber).to.equal(950); // Should be sorted desc
      expect(result.events[1].blockNumber).to.equal(940);
      expect(result.totalBlocksSearched).to.be.greaterThan(0);
      expect(paginatedEventQueryStub).to.have.been.called;
    });

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

      mockCache.get.resolves(JSON.stringify(cachedEvents));

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(1);
      expect(result.cacheHits).to.equal(1);
      expect(mockCache.get).to.have.been.called;
    });

    it("should adapt chunk size when no events found", async () => {
      const fetchEventsStub = sinon.stub();
      // First call returns no events, second call returns events
      fetchEventsStub.onFirstCall().resolves([]);
      fetchEventsStub.onSecondCall().resolves([
        {
          event: "FundsDeposited",
          blockNumber: 800,
          logIndex: 0,
          transactionHash: "0xabc",
          transactionIndex: 0,
          blockHash: "0x999",
          args: {},
        } as Log,
      ]);

      (searcher as any).fetchEventsForRange = fetchEventsStub;

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 300,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(1);
      expect(fetchEventsStub).to.have.been.calledTwice;
      // Verify chunk size was increased after first empty result
      expect(fetchEventsStub.secondCall.args[1] - fetchEventsStub.secondCall.args[0]).to.be.greaterThan(50);
    });

    it("should stop early when max events reached", async () => {
      const manyEvents: Log[] = [];
      for (let i = 0; i < 20; i++) {
        manyEvents.push({
          event: "FundsDeposited",
          blockNumber: 1000 - i,
          logIndex: i,
          transactionHash: `0x${i.toString(16).padStart(64, "0")}`,
          transactionIndex: 0,
          blockHash: `0x${i.toString(16).padStart(64, "0")}`,
          args: {},
        } as Log);
      }

      const fetchEventsStub = sinon.stub().resolves(manyEvents);
      (searcher as any).fetchEventsForRange = fetchEventsStub;

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 5, // Limit to 5 events
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(5);
      expect(result.events[0].blockNumber).to.be.greaterThan(result.events[4].blockNumber);
    });

    it("should respect target block limit", async () => {
      const fetchEventsStub = sinon.stub().resolves([]);
      (searcher as any).fetchEventsForRange = fetchEventsStub;

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 100,
        maxBlocksBack: 1000,
        targetBlock: 950, // Should not search below block 950
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      const result = await searcher.searchBackward(1000, config);

      expect(result.searchedToBlock).to.be.greaterThanOrEqual(950);
      expect(fetchEventsStub).to.have.been.called;
      // Verify no calls searched below the target block
      fetchEventsStub.getCalls().forEach(call => {
        expect(call.args[0]).to.be.greaterThanOrEqual(950); // fromBlock should be >= targetBlock
      });
    });

    it("should handle RPC errors gracefully", async () => {
      const fetchEventsStub = sinon.stub();
      fetchEventsStub.onFirstCall().rejects(new Error("RPC Error"));
      fetchEventsStub.onSecondCall().resolves([]);

      (searcher as any).fetchEventsForRange = fetchEventsStub;

      const config: BackwardSearchConfig = {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 10,
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      };

      // Should not throw, but return empty results
      const result = await searcher.searchBackward(1000, config);

      expect(result.events).to.have.length(0);
      expect(fetchEventsStub).to.have.been.called;
    });
  });

  describe("findMostRecentEvent", () => {
    it("should return the most recent event", async () => {
      const mockEvent: Log = {
        event: "FundsDeposited",
        blockNumber: 999,
        logIndex: 5,
        transactionHash: "0xlatest",
        transactionIndex: 2,
        blockHash: "0xrecent",
        args: {},
      } as Log;

      const searchBackwardStub = sinon.stub(searcher, "searchBackward").resolves({
        events: [mockEvent],
        searchedToBlock: 900,
        totalBlocksSearched: 100,
        cacheHits: 0,
        searchTimeMs: 500,
      });

      const result = await searcher.findMostRecentEvent(1000, {
        eventsToFind: ["FundsDeposited"],
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      });

      expect(result).to.deep.equal(mockEvent);
      expect(searchBackwardStub).to.have.been.calledWith(1000, sinon.match({ maxEvents: 1 }));
    });

    it("should return null when no events found", async () => {
      const searchBackwardStub = sinon.stub(searcher, "searchBackward").resolves({
        events: [],
        searchedToBlock: 900,
        totalBlocksSearched: 100,
        cacheHits: 0,
        searchTimeMs: 500,
      });

      const result = await searcher.findMostRecentEvent(1000, {
        eventsToFind: ["FundsDeposited"],
        maxBlocksBack: 100,
        initialChunkSize: 50,
        maxChunkSize: 200,
        chunkGrowthFactor: 2.0,
      });

      expect(result).to.be.null;
    });
  });

  describe("findEventsInTimeWindow", () => {
    it("should find events within time window", async () => {
      const currentTime = Math.floor(Date.now() / 1000);
      const mockEvents: Log[] = [
        {
          event: "FundsDeposited",
          blockNumber: 990,
          logIndex: 0,
          transactionHash: "0x1",
          transactionIndex: 0,
          blockHash: "0xa",
          args: {},
        } as Log,
      ];

      mockContract.provider.getBlock = sinon.stub().resolves({ timestamp: currentTime });

      const searchBackwardStub = sinon.stub(searcher, "searchBackward").resolves({
        events: mockEvents,
        searchedToBlock: 800,
        totalBlocksSearched: 200,
        cacheHits: 1,
        searchTimeMs: 750,
      });

      const result = await searcher.findEventsInTimeWindow(1000, 3600, {
        eventsToFind: ["FundsDeposited"],
        maxEvents: 50,
        initialChunkSize: 100,
        maxChunkSize: 1000,
        chunkGrowthFactor: 1.8,
      });

      expect(result.events).to.have.length(1);
      expect(searchBackwardStub).to.have.been.called;
      
      // Verify it estimated reasonable block lookback (3600 seconds / 12 seconds per block * 2 buffer)
      const callArgs = searchBackwardStub.firstCall.args[1];
      expect(callArgs.maxBlocksBack).to.be.greaterThan(300); // Should be around 600 with buffer
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
      expect(result.totalBlocksSearched).to.equal(0);
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
      expect(result.searchedToBlock).to.equal(1001); // Should be fromBlock + 1
    });

    it("should validate configuration parameters", async () => {
      const invalidConfigs = [
        { maxBlocksBack: -1 },
        { initialChunkSize: 0 },
        { maxChunkSize: 10, initialChunkSize: 20 }, // maxChunkSize < initialChunkSize
        { chunkGrowthFactor: 0.5 }, // < 1.0
      ];

      for (const invalidConfig of invalidConfigs) {
        const config: BackwardSearchConfig = {
          eventsToFind: ["FundsDeposited"],
          maxEvents: 10,
          maxBlocksBack: 100,
          initialChunkSize: 50,
          maxChunkSize: 200,
          chunkGrowthFactor: 2.0,
          ...invalidConfig,
        };

        await expect(searcher.searchBackward(1000, config)).to.be.rejected;
      }
    });
  });
});